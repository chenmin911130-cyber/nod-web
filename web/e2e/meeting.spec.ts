import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

/**
 * Meeting line continuation (issue #29), driven over a mocked WS so the server
 * → client path is exercised end-to-end. This is the RED line that would have
 * caught the bridge whitelist gap: a `line_update` frame must REACH the reducer
 * and merge the open line's text — not be dropped, and not create a second row.
 *
 * Scope: this spec proves the bridge now forwards `line_update` and the reducer
 * merges it. The REV-GATING of a late translation (stale-rev chunk dropped,
 * stale done → clear + re-ask) is covered by the pure-function unit tests in
 * meetingLines.test.ts (applyLineTranslationRev / staleTranslateDone) — it needs
 * a real translate ask binding, which the mocked WS here does not establish.
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
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    expect(ws).toBeTruthy()
    const send = (m: Record<string, unknown>) => ws!.send(JSON.stringify(m))

    // Settle the phase so the pane is live, then push a meeting line.
    send({ type: 'phase', capture: 'off', engine: 'idle' })
    send({ type: 'question', id: 'm1', text: 'So one of the significant' })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant')

    // The continuation arrives: it must MERGE into the same row (rev bumped) and
    // replace the text, not create a second row.
    send({ type: 'line_update', id: 'm1', text: 'So one of the significant features', rev: 1 })
    await expect(page.locator('.listen-line')).toHaveCount(1)
    await expect(page.locator('.listen-line .listen-orig').first()).toHaveText('So one of the significant features')
  })
})
