import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

test.describe('Listen mobile chrome', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('New is on Listen, hidden on Translate; Translate Ask starts collapsed', async ({ page }) => {
    await page.goto('/app')
    await expect(page.locator('html')).toHaveClass(/nod-phone/)
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible()
    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible()
    await expect(page.locator('input.prompt-input')).toHaveCount(0)
    await page.getByRole('button', { name: 'Ask' }).click()
    await expect(page.locator('input.prompt-input')).toBeVisible()
    await page.locator('input.prompt-input').fill('keep this draft')
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('input.prompt-input')).toHaveCount(0)
    await page.getByRole('button', { name: 'Ask' }).click()
    await expect(page.locator('input.prompt-input')).toHaveValue('keep this draft')
    await page.screenshot({ path: '../docs/design/listen-mobile-2026-09-11/evidence/translate-ask-open-390.png' })
  })

  test('demo meeting keeps Ask as a bubble and transcript sentence cards', async ({ page }) => {
    await page.goto('/app?demo=meeting-notes')
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible()
    await expect(page.getByPlaceholder(/Ask about this conversation/)).toHaveCount(0)
    await page.screenshot({ path: '../docs/design/listen-mobile-2026-09-11/evidence/notes-demo-390.png' })
    await page.getByRole('tab', { name: 'Live' }).click()
    await page.screenshot({ path: '../docs/design/listen-mobile-2026-09-11/evidence/live-demo-390.png' })
    await page.getByRole('tab', { name: 'Transcript' }).click()
    await expect(page.locator('.iphone-tr-card')).toHaveCount(3)
    await page.screenshot({ path: '../docs/design/listen-mobile-2026-09-11/evidence/transcript-cards-390.png' })
    await expect(page.getByText('All captured speech')).toHaveCount(0)
    await expect(page.getByText('All captured speech')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()
    await page.getByRole('button', { name: 'Ask' }).click()
    await expect(page.getByPlaceholder(/Ask about this conversation|Ask a follow-up/)).toBeVisible()
  })
})

test.describe('Listen mobile recording chrome', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('listening hides New and uses the bottom rec bar, not the top row', async ({ page }) => {
    let ws: WebSocketRoute | undefined
    await page.routeWebSocket(/\/ws$/, (route) => {
      ws = route
    })
    await page.goto('/app?demo=meeting')
    await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible()
    ws!.send(JSON.stringify({ type: 'phase', capture: 'listening', engine: 'idle' }))
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.locator('.iphone-live-bar')).toBeVisible()
    await expect(page.locator('.iphone-actions.live')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
    await page.screenshot({ path: '../docs/design/listen-mobile-2026-09-11/evidence/recording-bar-390.png' })
    await page.getByRole('button', { name: 'Ask' }).click()
    await expect(page.getByPlaceholder(/Ask about this conversation|Ask a follow-up/)).toBeVisible()
    await expect(page.locator('.iphone-live-bar')).toBeVisible()
    await page.screenshot({ path: '../docs/design/listen-mobile-2026-09-11/evidence/recording-ask-390.png' })
  })
})

test.describe('Listen mobile small phone', () => {
  test.use({ viewport: { width: 320, height: 568 } })

  test('compact New and Ask stay tappable', async ({ page }) => {
    await page.goto('/app?demo=meeting-notes')
    const neu = page.getByRole('button', { name: 'New session' })
    await expect(neu).toBeVisible()
    const box = await neu.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    const ask = page.getByRole('button', { name: 'Ask' })
    await expect(ask).toBeVisible()
    const askBox = await ask.boundingBox()
    expect(askBox!.width).toBeGreaterThanOrEqual(44)
    expect(askBox!.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: '../docs/design/listen-mobile-2026-09-11/evidence/listen-demo-320.png' })
  })
})
