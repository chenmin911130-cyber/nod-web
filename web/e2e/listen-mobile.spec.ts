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

const EVIDENCE = '../docs/design/listen-mobile-2026-09-11/evidence'

async function mockListenWs(page: import('@playwright/test').Page) {
  let ws: WebSocketRoute | undefined
  await page.routeWebSocket(/\/ws$/, (route) => {
    ws = route
  })
  const send = (msg: Record<string, unknown>) => {
    if (!ws) throw new Error('websocket not connected')
    ws.send(JSON.stringify(msg))
  }
  return {
    send,
    async gotoListening() {
      await page.goto('/app?demo=meeting')
      await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
      send({ type: 'phase', capture: 'listening', engine: 'idle' })
      await expect(page.locator('.iphone-live-bar')).toBeVisible()
    },
    async endSession() {
      await page.getByRole('button', { name: 'End' }).click()
      send({ type: 'phase', capture: 'off', engine: 'idle' })
      await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
    },
  }
}

test.describe('Listen mobile recording chrome', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('listening hides New and uses the bottom rec bar, not the top row', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.locator('.iphone-actions.live')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/recording-bar-390.png` })
    await page.getByRole('button', { name: 'Ask' }).click()
    await expect(page.getByPlaceholder(/Ask about this conversation|Ask a follow-up/)).toBeVisible()
    await expect(page.locator('.iphone-live-bar')).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/recording-ask-390.png` })
  })

  test('pause hides New, keeps the rec bar, and shows Resume', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'phase', capture: 'paused', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.locator('.iphone-live-bar')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/recording-paused-390.png` })
  })

  test('ended sheet peeks results by default and the handle click expands it', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await ws.endSession()
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Live' })).toBeVisible()
    await expect(page.getByText('Applies to next recording')).toBeVisible()
    const peek = page.locator('.iphone-live-feed-wrap')
    await expect(peek).toBeVisible()
    await expect(peek).toContainText('launch window')
    const peekBox = await peek.evaluate((el) => {
      const style = getComputedStyle(el)
      return { display: style.display, maxHeight: style.maxHeight, height: el.getBoundingClientRect().height }
    })
    expect(peekBox.display).not.toBe('none')
    expect(peekBox.height).toBeGreaterThanOrEqual(88)
    expect(peekBox.height).toBeLessThanOrEqual(180)
    await page.screenshot({ path: `${EVIDENCE}/ended-sheet-default-390.png` })
    await page.getByRole('button', { name: 'Show transcript' }).click()
    await expect(page.getByRole('button', { name: 'Show settings' })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Applies to next recording')).not.toBeVisible()
    const expanded = await peek.evaluate((el) => el.getBoundingClientRect().height)
    expect(expanded).toBeGreaterThan(peekBox.height)
    await page.screenshot({ path: `${EVIDENCE}/ended-sheet-expanded-390.png` })
  })

  test('Continue keeps the same-session Ask draft', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await page.getByRole('button', { name: 'Ask' }).click()
    const ask = page.getByPlaceholder(/Ask about this conversation|Ask a follow-up/)
    await expect(ask).toBeVisible()
    await ask.fill('keep through continue')
    await ws.endSession()
    await page.getByRole('button', { name: 'Continue' }).click()
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await expect(page.locator('.iphone-live-bar')).toBeVisible()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.getByPlaceholder(/Ask about this conversation|Ask a follow-up/)).toHaveValue('keep through continue')
  })

  test('save failure on the ended sheet shows Retry', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await ws.endSession()
    await expect(page.getByText('Save this session?')).toBeVisible()
    await page.locator('.save-banner-save').click()
    await expect(page.getByRole('dialog', { name: 'Save to History?' })).toBeVisible()
    await page.getByRole('dialog', { name: 'Save to History?' }).getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saving…')).toBeVisible()
    ws.send({ type: 'history_keep_failed' })
    await expect(page.getByText("Couldn't save.")).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/ended-save-failed-390.png` })
  })

  test('kb-open layout keeps the rec bar and Ask field in the visual viewport', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await page.getByRole('button', { name: 'Ask' }).click()
    const ask = page.getByPlaceholder(/Ask about this conversation|Ask a follow-up/)
    await expect(ask).toBeVisible()
    // Playwright cannot show the iOS keyboard. Native WKWebView resizes to the
    // visual viewport; keyboardInset then sets these same classes/vars.
    await page.evaluate(() => {
      const root = document.documentElement
      root.classList.add('nod-native', 'kb-open')
      root.style.setProperty('--vv-height', '520px')
      root.style.setProperty('--vv-shift', '0px')
      root.style.setProperty('--kb-inset', '324px')
    })
    await page.setViewportSize({ width: 390, height: 520 })
    const rec = page.locator('.iphone-live-bar')
    await expect(rec).toBeVisible()
    await expect(ask).toBeVisible()
    const boxes = await page.evaluate(() => {
      const recBar = document.querySelector('.iphone-live-bar')
      const field = document.querySelector('.listen-prompt input')
      const feed = document.querySelector('.iphone-live-feed-wrap, .listen-split')
      const recBox = recBar?.getBoundingClientRect()
      const fieldBox = field?.getBoundingClientRect()
      return {
        recBottom: recBox?.bottom ?? -1,
        fieldBottom: fieldBox?.bottom ?? -1,
        viewport: window.innerHeight,
        feedOverflow: feed ? getComputedStyle(feed).overflow : '',
      }
    })
    expect(boxes.recBottom).toBeGreaterThan(0)
    expect(boxes.recBottom).toBeLessThanOrEqual(boxes.viewport)
    expect(boxes.fieldBottom).toBeGreaterThan(0)
    expect(boxes.fieldBottom).toBeLessThanOrEqual(boxes.viewport)
    expect(boxes.feedOverflow).toMatch(/auto|scroll/)
    await page.screenshot({ path: `${EVIDENCE}/recording-ask-kb-layout-390.png` })
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

test.describe('Listen mobile ended sheet tab bar', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  const dragBar = async (page: import('@playwright/test').Page, dy: number) => {
    const box = (await page.locator('.listen-mobile-tabs').boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy + dy, { steps: 10 })
    await page.mouse.up()
  }

  test('taps switch Live/Transcript/Notes and drags move the dock', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await ws.endSession()
    const tab = (name: string) => page.getByRole('tab', { name })
    const handle = page.locator('.iphone-ended-handle')
    await expect(handle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.listen-mobile-tabs')).toHaveCSS('touch-action', 'none')

    // Transcript: a tap must switch the pane (and the sheet expands, per design)
    await tab('Transcript').click()
    await expect(tab('Transcript')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.iphone-tr-card').first()).toBeVisible()
    await expect(handle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Applies to next recording')).not.toBeVisible()
    await expect(page.locator('.listen-mobile-tabs')).toHaveCSS('touch-action', 'none')

    // Notes, then back to Live
    await tab('Notes').click()
    await expect(tab('Notes')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('section.listen-notes')).toBeVisible()
    await tab('Live').click()
    await expect(tab('Live')).toHaveAttribute('aria-selected', 'true')

    // drag down -> default dock, settings visible again
    await dragBar(page, 90)
    await expect(handle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Applies to next recording')).toBeVisible()

    // drag up -> expanded dock, settings covered
    await dragBar(page, -90)
    await expect(handle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Applies to next recording')).not.toBeVisible()

    // a drag must not eat the next tap on a tab
    await tab('Transcript').click()
    await expect(tab('Transcript')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.iphone-tr-card').first()).toBeVisible()
  })
})
