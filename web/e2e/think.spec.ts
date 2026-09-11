import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'
import { mkdirSync } from 'node:fs'

/**
 * Think (#182) — the Live Q&A switch, the value a submit carries, and the
 * sources block under the answer.
 *
 * Same harness as the other specs: the page runs with a fully mocked WebSocket
 * and the `?demo=interview` seed, so CI never reaches a provider and every event
 * below is deterministic. The frames the client sends are read off the routed
 * socket, which is the real submit path (bridge -> WS), not an internal call.
 *
 *   npx playwright test e2e/think.spec.ts
 */

const SHOTS = '../docs/design/think-182'

type Frame = Record<string, unknown>

async function mockWs(page: import('@playwright/test').Page, url = '/app?demo=interview') {
  const sent: Frame[] = []
  let route: WebSocketRoute | undefined
  await page.routeWebSocket(/\/ws$/, (ws) => {
    route = ws
    ws.onMessage((message) => {
      try {
        sent.push(JSON.parse(String(message)))
      } catch {
        /* non-JSON frames are not this spec's business */
      }
    })
  })
  await page.goto(url)
  await expect.poll(() => route !== undefined, { timeout: 5000 }).toBe(true)
  const send = (ev: Frame) => {
    if (!route) throw new Error('websocket not connected')
    route.send(JSON.stringify(ev))
  }
  return { sent, send }
}

function shot(page: import('@playwright/test').Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  return page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test.describe('Think switch', () => {
  test('sits above the Live Q&A input, defaults to off, and is absent elsewhere', async ({ page }) => {
    await mockWs(page)

    const toggle = page.getByRole('switch', { name: 'Think' })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toHaveText(/^Think$/)

    // It sits ABOVE the existing input, which stays visible and unchanged.
    const toggleBox = await toggle.boundingBox()
    const inputBox = await page.locator('.prompt-input').boundingBox()
    expect(toggleBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(toggleBox!.y).toBeLessThan(inputBox!.y)
    await expect(page.locator('.prompt-input')).toBeVisible()
    await shot(page, 'interview-think-off')

    // Translate has no Live Q&A input, so the switch must not appear there.
    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByRole('switch', { name: 'Think' })).toHaveCount(0)
  })

  test('carries its value onto the submit, and New puts it back to off', async ({ page }) => {
    const { sent, send } = await mockWs(page)
    const toggle = page.getByRole('switch', { name: 'Think' })

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => sent.filter((m) => m.type === 'set_think').length, {
        message: 'the switch must reach the server',
      })
      .toBeGreaterThan(0)
    const setThink = sent.filter((m) => m.type === 'set_think')
    expect(setThink[setThink.length - 1].on).toBe(true)
    await shot(page, 'interview-think-on')

    // A question submitted now goes out with the value it was submitted under.
    await page.locator('.prompt-input').fill('what is new?')
    await page.locator('.prompt-input').press('Enter')
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    expect(sent.filter((m) => m.type === 'ask')[0].think).toBe(true)

    // Finish that answer so the composer is free again (a real server would send
    // these; the mocked one must too, or the next submit is blocked by `busy`).
    send({ type: 'question', id: 'q1', text: 'what is new?' })
    send({ type: 'chunk', id: 'q1', text: 'ok' })
    send({ type: 'done', id: 'q1', stt: 0, llm: 1, ok: true })
    await expect(toggle).toBeEnabled()

    // Flip it off: the NEXT submit carries the new value.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.locator('.prompt-input').fill('and now?')
    await page.locator('.prompt-input').press('Enter')
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(2)
    expect(sent.filter((m) => m.type === 'ask')[1].think).toBe(false)

    // New / clear starts a fresh session: back to the default. (The shortcut is
    // ignored while a text field has focus, exactly like the app intends.)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.locator('.prompt-input').blur()
    await page.keyboard.press('F4')
    // The session has content, so New asks first — confirm it.
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})

test.describe('Think answer rendering', () => {
  test('shows the real sources and the retrieval time, and nothing extra for a plain answer', async ({ page }) => {
    const { send } = await mockWs(page)

    send({ type: 'question', id: 'q-think', text: 'What did Apple announce?' })
    send({ type: 'chunk', id: 'q-think', text: 'A new model.' })
    send({
      type: 'sources',
      id: 'q-think',
      status: 'ok',
      retrieved_at: 1789012800,
      retrieved_at_text: '2026-09-10 04:00 UTC',
      results: [{ title: 'Apple News', url: 'https://example.com/apple', published_at: '2026-09-10' }],
      note: '',
    })
    send({ type: 'done', id: 'q-think', stt: 0, llm: 1, ok: true })

    const link = page.getByRole('link', { name: 'Apple News' })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'https://example.com/apple')
    await expect(page.getByText('检索时间：2026-09-10 04:00 UTC')).toBeVisible()
    await expect(page.getByText(/2026-09-10/).first()).toBeVisible()
    await shot(page, 'interview-sources')

    // A lookup that did not run says so instead of showing sources.
    send({ type: 'question', id: 'q-empty', text: 'Anything at all?' })
    send({ type: 'chunk', id: 'q-empty', text: 'An answer without retrieval.' })
    send({
      type: 'sources',
      id: 'q-empty',
      status: 'failed',
      retrieved_at: 1789012801,
      retrieved_at_text: '2026-09-10 04:00 UTC',
      results: [],
      note: '联网检索失败（TimeoutError），本次回答未使用最新检索资料。',
    })
    send({ type: 'done', id: 'q-empty', stt: 0, llm: 1, ok: true })
    await expect(page.getByText('联网检索失败（TimeoutError），本次回答未使用最新检索资料。')).toBeVisible()

    // A plain answer (no sources event at all) must not grow an empty block.
    send({ type: 'question', id: 'q-plain', text: 'Plain question?' })
    send({ type: 'chunk', id: 'q-plain', text: 'Plain answer.' })
    send({ type: 'done', id: 'q-plain', stt: 0, llm: 1, ok: true })
    await expect(page.getByText('Plain answer.')).toBeVisible()
    // The seeded demo turns have none either: exactly the two answers above show a block.
    await expect(page.locator('.qa-sources')).toHaveCount(2)
  })
})

/**
 * Phone-width before/after evidence (#182 acceptance: the composer must stay
 * usable with the keyboard up). The on-screen keyboard itself is a native
 * overlay a browser cannot draw — the layout side of that is covered by the
 * `keyboardInset` unit test — so these shots pin the phone layout itself.
 */
test.describe('Think on a phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('shows the switch above the composer, off and on', async ({ page }) => {
    const { send } = await mockWs(page)
    // A phone only has the Live Q&A composer inside a live session: on its own
    // Ready screen there is no input to sit above. Mark capture listening.
    send({ type: 'phase', capture: 'listening', engine: 'idle' })
    const toggle = page.getByRole('switch', { name: 'Think' })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await shot(page, 'phone-think-off')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'phone-think-on')
  })
})
