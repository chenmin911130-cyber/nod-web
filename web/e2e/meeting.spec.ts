import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

/**
 * Meeting line continuation + translation, driven over a mocked WS so the FULL
 * translate chain is exercised end-to-end (issue #29):
 *   real ask binding -> first translation appears -> source extends (line_update)
 *   -> the OLD ask's late done is rejected (rev gate) and re-pumped -> the NEW
 *   translation completes -> the OLD ask's late chunk is ignored.
 *
 * The server answers a translate ask by sending a `question` frame whose text
 * starts with `[NOD_TRANSLATE:<lineId>]`; the client binds `translateAskId` to
 * that frame's id and `translateBindId` to the lineId, then routes chunks by
 * `isTranslateChunk(translateAskId, ev.id)` and gates them by the line's rev.
 */
test.describe('Meeting translation continuation', () => {
  test('a late done/chunk from the old ask is dropped and the new translation completes', async ({ page }) => {
    let ws: WebSocketRoute | undefined
    let askSeq = 0
    await page.routeWebSocket(/\/ws$/, (route) => {
      ws = route
      route.onMessage((message) => {
        let m: { type?: string; mode?: string; text?: string } | null = null
        try { m = JSON.parse(String(message)) } catch { return }
        if (m?.type !== 'ask' || m.mode !== 'translate' || !m.text) return
        const lineId = /^\[NOD_TRANSLATE:([^\]]+)\]/.exec(m.text)?.[1]
        if (!lineId) return
        // Answer the ask with a translate question frame so the client binds.
        askSeq += 1
        route.send(JSON.stringify({ type: 'question', id: `ask${askSeq}`, text: `[NOD_TRANSLATE:${lineId}]\nTranslate to English.` }))
      })
    })

    await page.goto('/app')
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    expect(ws).toBeTruthy()
    const send = (msg: Record<string, unknown>) => ws!.send(JSON.stringify(msg))

    // Notes Auto follows speech and does not pump captions. Pick a concrete
    // notes language so Bilingual is on for this continuation test.
    await page.getByLabel('Notes language').click()
    await page.getByRole('option', { name: /english/i }).click()
    await expect(page.getByRole('switch', { name: /bilingual/i })).toHaveAttribute('aria-checked', 'true')

    // 1. A spoken meeting line arrives -> app pumps a translate ask for it.
    send({ type: 'phase', capture: 'off', engine: 'idle' })
    send({ type: 'question', id: 'm1', text: 'So one of the significant' })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant')
    await expect.poll(() => askSeq, { timeout: 2000 }).toBeGreaterThan(0) // ask1 bound

    // 2. First translation appears (rev 0).
    await page.waitForTimeout(250) // let the client bind ask1 (question frame processed)
    send({ type: 'chunk', id: 'ask1', text: 'one significant' })
    await expect(page.locator('.listen-line .listen-tr').first()).toHaveText('one significant')

    // 3. The source is CONTINUED -> line merges, translation cleared, rev bumped.
    send({ type: 'line_update', id: 'm1', text: 'So one of the significant features', rev: 1 })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant features')
    await expect(page.locator('.listen-line .listen-tr').first()).toHaveCount(0)

    // 4. The OLD ask's done arrives late: rev gate rejects it and re-pumps.
    send({ type: 'done', id: 'ask1', stt: 0, llm: 1, ok: true })
    await expect.poll(() => askSeq, { timeout: 2500 }).toBeGreaterThan(1) // ask2 re-bound

    // 5. The NEW translation completes.
    send({ type: 'chunk', id: 'ask2', text: 'significant features' })
    await expect(page.locator('.listen-line .listen-tr').first()).toHaveText('significant features')

    // 6. The OLD ask's late chunk is ignored (its ask id no longer bound).
    send({ type: 'chunk', id: 'ask1', text: 'stale old translation' })
    await page.waitForTimeout(250)
    await expect(page.locator('.listen-line .listen-tr').first()).toHaveText('significant features')
    await expect(page.locator('.listen-line')).toHaveCount(1)
  })

  test('a line_update clears the live partial (no half-sentence row lingers)', async ({ page }) => {
    let ws: WebSocketRoute | undefined
    await page.routeWebSocket(/\/ws$/, (route) => {
      ws = route
    })

    await page.goto('/app')
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    expect(ws).toBeTruthy()
    const send = (msg: Record<string, unknown>) => ws!.send(JSON.stringify(msg))

    // 1. A finalized meeting line arrives.
    send({ type: 'phase', capture: 'off', engine: 'idle' })
    send({ type: 'question', id: 'm1', text: 'So one of the significant' })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant')

    // 2. The SAME thought is still being transcribed: a live partial appears.
    send({ type: 'partial', text: 'So one of the significant' })
    await expect(page.locator('.listen-line.live')).toHaveCount(1)
    await expect(page.locator('.listen-line.live .listen-orig')).toHaveText('So one of the significant')

    // 3. The turn is continued (line_update): the merge finalizes the line and
    // the live partial must be cleared — no lingering half-sentence row.
    send({ type: 'line_update', id: 'm1', text: 'So one of the significant features', rev: 1 })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line.live')).toHaveCount(0)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant features')
  })

  test('End waits for listen_flush before notes, including a same-row line_update', async ({ page }) => {
    let ws: WebSocketRoute | undefined
    const notesAsks: string[] = []
    let stopFlushId = ''
    await page.routeWebSocket(/\/ws$/, (route) => {
      ws = route
      route.onMessage((message) => {
        let m: { type?: string; mode?: string; text?: string; flush_id?: string } | null = null
        try { m = JSON.parse(String(message)) } catch { return }
        if (m?.type === 'stop_listen' && m.flush_id) stopFlushId = m.flush_id
        if (m?.type === 'ask' && m.mode === 'notes' && m.text) notesAsks.push(m.text)
      })
    })

    await page.goto('/app')
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    expect(ws).toBeTruthy()
    const send = (msg: Record<string, unknown>) => ws!.send(JSON.stringify(msg))

    await page.getByLabel('Notes language').click()
    await page.getByRole('option', { name: /english/i }).click()

    send({ type: 'phase', capture: 'listening', engine: 'idle' })
    send({ type: 'question', id: 'm1', text: "So throughout this presentation, instead of asking you to drop a yes in the chat like I normally do, I'm" })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => stopFlushId).not.toBe('')

    send({ type: 'phase', capture: 'off', engine: 'idle' })
    send({
      type: 'line_update',
      id: 'm1',
      rev: 1,
      text: "So throughout this presentation, instead of asking you to drop a yes in the chat like I normally do, I'm going to look to that reaction button. Let's get into it.",
    })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    send({ type: 'listen_flush', id: '1', flush_id: 'f-old', ok: true })
    await expect.poll(() => notesAsks.length).toBe(0)

    send({ type: 'listen_flush', id: '2', flush_id: stopFlushId, ok: true })
    await expect.poll(() => notesAsks.length, { timeout: 3000 }).toBe(1)
    expect(notesAsks[0]).toContain("Let's get into it")
    expect(notesAsks.length).toBe(1)
  })

  test('empty transcript after End does not ask for notes', async ({ page }) => {
    let ws: WebSocketRoute | undefined
    const notesAsks: string[] = []
    await page.routeWebSocket(/\/ws$/, (route) => {
      ws = route
      route.onMessage((message) => {
        let m: { type?: string; mode?: string } | null = null
        try { m = JSON.parse(String(message)) } catch { return }
        if (m?.type === 'ask' && m.mode === 'notes') notesAsks.push('notes')
      })
    })

    await page.goto('/app')
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    const send = (msg: Record<string, unknown>) => ws!.send(JSON.stringify(msg))
    send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    send({ type: 'phase', capture: 'off', engine: 'idle' })
    send({ type: 'listen_flush', id: '1', ok: true })
    await page.waitForTimeout(400)
    expect(notesAsks).toEqual([])
  })

  test('stale listen_flush after a new session does not generate notes', async ({ page }) => {
    let ws: WebSocketRoute | undefined
    const notesAsks: string[] = []
    await page.routeWebSocket(/\/ws$/, (route) => {
      ws = route
      route.onMessage((message) => {
        let m: { type?: string; mode?: string; text?: string } | null = null
        try { m = JSON.parse(String(message)) } catch { return }
        if (m?.type === 'ask' && m.mode === 'notes' && m.text) notesAsks.push(m.text)
      })
    })

    await page.goto('/app')
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    const send = (msg: Record<string, unknown>) => ws!.send(JSON.stringify(msg))
    send({ type: 'phase', capture: 'listening', engine: 'idle' })
    send({ type: 'question', id: 'm1', text: "I'm" })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    send({ type: 'phase', capture: 'listening', engine: 'idle' })
    send({ type: 'listen_flush', id: '1', ok: true })
    await page.waitForTimeout(400)
    expect(notesAsks).toEqual([])
  })
})
