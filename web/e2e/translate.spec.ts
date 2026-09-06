import { test, expect } from '@playwright/test'

/**
 * Translate typing must never have TWO `ask` messages in flight at once.
 *
 * 6b69afc P0 residual: on `phase(capture='off', engine='idle')` the client's
 * dead-air fallback (App.tsx ~1310) treats "engine idle but I still think a
 * translate is in flight" as stuck and re-pumps. When the server emits `done`
 * followed by a trailing `phase(idle)` for round #1, the client's `done`
 * microtask has already sent retry #2 and set `inflight` to #2; the trailing
 * idle for #1 then arrives, kills #2, and fires #3 — two asks in flight at
 * once (双发 → 叠字 on the row). This is invariant to LLM success/failure:
 * any retry path (done with no translation, wrong-script retry) can overlap.
 *
 * So the gate is a frame-level invariant: an `ask` may only be sent once the
 * previous `ask`'s `done` has been received. Sequential retries are legal;
 * an in-flight overlap is the bug. Assert on WS frames, not on `api.send` —
 * the raw send layer can't see the server's done/phase, which is what drives
 * the retry.
 */
test.describe('Translate workspace typing', () => {
  test('asks never overlap (previous done received before the next ask)', async ({ page }) => {
    let inflight = 0
    let asks = 0
    let overlap = false

    // Attach BEFORE navigation so the app's /ws connection is captured.
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        const p = frame.payload
        if (typeof p !== 'string') return
        let m: { type?: string } | null = null
        try { m = JSON.parse(p) } catch { return }
        if (m?.type === 'ask') {
          asks += 1
          if (inflight > 0) overlap = true
          inflight += 1
        }
      })
      ws.on('framereceived', (frame) => {
        const p = frame.payload
        if (typeof p !== 'string') return
        let m: { type?: string } | null = null
        try { m = JSON.parse(p) } catch { return }
        if (m?.type === 'done') {
          inflight = Math.max(0, inflight - 1)
        }
      })
    })

    await page.goto('/app')
    const translateTab = page.getByRole('tab', { name: /translate/i })
    await translateTab.click()

    const input = page.locator('input.prompt-input')
    await expect(input).toBeVisible()
    const line = 'Dobbiamo finire il lavoro entro domani'
    await input.fill(line)
    await input.press('Enter')

    // Let the ask + done (ok:false with a mocked key) + retries + the trailing
    // idle round-trip run well past the overlap window.
    await page.waitForTimeout(2000)

    expect(asks).toBeGreaterThan(0)
    expect(overlap).toBe(false)
  })
})
