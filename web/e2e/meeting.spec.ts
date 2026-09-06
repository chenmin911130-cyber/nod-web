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
})
