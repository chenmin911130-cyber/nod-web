import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

/**
 * Meeting line continuation (issue #29), driven over a mocked WS so the server
 * → client path is exercised end-to-end. This is the RED line that would have
 * caught the bridge whitelist gap: a `line_update` frame must REACH the reducer
 * and merge the open line's text — not be dropped, and not create a second row.
 *
 * The app boots into the meeting workspace, so no real STT/LLM is needed — we
 * only push server events into the client.
 */
test.describe('Meeting continuation', () => {
  test('a line_update merges the open line instead of a second row', async ({ page }) => {
    let ws: WebSocketRoute | undefined
    await page.routeWebSocket(/\/ws$/, (route) => {
      ws = route
      route.onMessage(() => {
        /* swallow the client's ask / ping frames */
      })
    })

    await page.goto('/app')
    // Wait until the mock WS is wired up (the app connects on boot).
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    expect(ws).toBeTruthy()
    const send = (m: Record<string, unknown>) => ws!.send(JSON.stringify(m))

    // Settle the phase so the pane is live, then push a meeting line.
    send({ type: 'phase', capture: 'off', engine: 'idle' })
    send({ type: 'question', id: 'm1', text: 'So one of the significant' })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant')

    // The continuation arrives: it must MERGE into the same row (rev bumped) and
    // replace the text, not create a second row and not leave a stale translation.
    send({ type: 'line_update', id: 'm1', text: 'So one of the significant features', rev: 1 })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant features')

    // A stale-rev translation chunk must not land on the extended line.
    send({ type: 'chunk', id: 'm1', text: 'stale half-sentence' })
    await page.waitForTimeout(250)
    await expect(page.locator('.listen-line .listen-tr').first()).toHaveCount(0)
  })
})
