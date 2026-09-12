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

test.describe('Translate phone chrome', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('ready chrome shows Auto-detect, empty title, and start button', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.locator('html')).toHaveClass(/nod-phone/)
    await expect(page.getByText('Ready to translate')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start voice translation' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start voice translation' })).toHaveCount(1)
    await expect(page.locator('.iphone-more-sq')).toHaveCount(0)
    const from = page.getByLabel('From')
    await expect(from).toHaveValue('auto')
    await expect(from.locator('option:checked')).toHaveText('Auto-detect')
    const to = page.getByLabel('To')
    await expect(to.locator('option:checked')).not.toHaveText('')
    await expect(page.getByRole('button', { name: 'More' })).toBeVisible()
    await expect(page.locator('.tr-voice-row')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Account' })).toBeVisible()
    const keyboard = page.getByRole('button', { name: 'Show keyboard' })
    await expect(keyboard).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ask' })).toHaveCount(0)
    await expect(page.locator('.iphone-tr-prompt')).toHaveCount(0)
    await keyboard.click()
    const typed = page.locator('.iphone-tr-prompt .prompt-input')
    await expect(typed).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hide keyboard' })).toBeVisible()
    await typed.fill('keep this draft')
    await page.getByRole('button', { name: 'Hide keyboard' }).click()
    await expect(page.locator('.iphone-tr-prompt')).toHaveCount(0)
    await page.getByRole('button', { name: 'Show keyboard' }).click()
    await expect(page.locator('.iphone-tr-prompt .prompt-input')).toHaveValue('keep this draft')
    await expect(page.getByRole('button', { name: 'Start voice translation' })).toBeVisible()
    await page.getByRole('button', { name: 'Account' }).click()
    await expect(page.getByText('Sign out')).toBeVisible()
    await expect(page.getByText('Delete account')).toBeVisible()
    await expect(page.getByText('Opacity')).toHaveCount(0)
    await page.getByText('Delete account').click()
    await expect(page.getByText('Delete my Nodpilot account')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Sign out')).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByText('Ready to translate')).toBeVisible()
  })
})

test.describe('Translate desktop chrome', () => {
  test('keeps the desktop empty copy and does not use the phone start CTA', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByRole('tab', { name: /translate/i })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'Start voice translation' })).toHaveCount(0)
    await expect(page.locator('.tr-voice-row')).toBeVisible()
    await expect(page.locator('.tr-swap')).toBeVisible()
  })
})
