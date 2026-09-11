import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'
import { mkdirSync } from 'node:fs'

/**
 * #193 before/after evidence. Same file, same viewport, same states — run it
 * once at the baseline commit (SHOTS=before) and once after the change
 * (SHOTS=after) and the two directories are directly comparable.
 *
 *   SHOTS=before npx playwright test e2e/chrome-shots.spec.ts
 */

const PHASE = process.env.SHOTS || 'before'
const ROOT = `../docs/design/listen-controls-193/${PHASE}`

test.use({ viewport: { width: 390, height: 844 } })

function shots() {
  mkdirSync(ROOT, { recursive: true })
}

async function mockWs(page: import('@playwright/test').Page, url = '/app?demo=meeting') {
  let ws: WebSocketRoute | undefined
  await page.routeWebSocket(/\/ws$/, (route) => {
    ws = route
  })
  const send = (msg: Record<string, unknown>) => {
    if (!ws) throw new Error('websocket not connected')
    ws.send(JSON.stringify(msg))
  }
  await page.goto(url)
  await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
  return { send }
}

async function shot(page: import('@playwright/test').Page, name: string) {
  shots()
  const width = page.viewportSize()?.width ?? 0
  await page.screenshot({ path: `${ROOT}/${name}-${width}.png` })
}

test('Listen states', async ({ page }) => {
  await page.goto('/app')
  await expect(page.locator('html')).toHaveClass(/nod-phone/)
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeVisible()
  await shot(page, 'listen-ready')

  // ready + the More sheet (Translate Save row evidence lives here too)
  await page.getByRole('button', { name: 'More' }).click()
  await shot(page, 'listen-more')
  await page.keyboard.press('Escape')

  const { send } = await mockWs(page)
  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  await expect(page.locator('.iphone-live-bar')).toBeVisible()
  await shot(page, 'listen-recording')

  send({ type: 'phase', capture: 'paused', engine: 'idle' })
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
  await shot(page, 'listen-paused')

  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  await expect(page.getByRole('button', { name: 'End' })).toBeVisible()

  await page.getByRole('button', { name: 'End' }).click()
  send({ type: 'phase', capture: 'off', engine: 'idle' })
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
  await shot(page, 'listen-ended-default')

  const handle = page.getByRole('button', { name: 'Show transcript' })
  if (await handle.count()) {
    await handle.click()
    await shot(page, 'listen-ended-expanded')
  }
})

test('Listen recording with Ask open and the keyboard layout', async ({ page }) => {
  const { send } = await mockWs(page)
  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  await expect(page.locator('.iphone-live-bar')).toBeVisible()
  await page.getByRole('button', { name: 'Ask' }).click()
  await expect(page.getByPlaceholder(/Ask about this conversation|Ask a follow-up/)).toBeVisible()
  await shot(page, 'listen-ask-open')

  await page.evaluate(() => {
    const root = document.documentElement
    root.classList.add('nod-native', 'kb-open')
    root.style.setProperty('--vv-height', '520px')
    root.style.setProperty('--vv-shift', '0px')
    root.style.setProperty('--kb-inset', '324px')
  })
  await page.setViewportSize({ width: 390, height: 520 })
  await shot(page, 'listen-ask-kb')
})

test('Translate states', async ({ page }) => {
  await page.goto('/app?demo=meeting')
  await page.getByRole('tab', { name: /translate/i }).click()
  await expect(page.getByRole('button', { name: 'Start voice translation' })).toBeVisible()
  await shot(page, 'translate-ready')

  const { send } = await mockWs(page, '/app?demo=meeting')
  await page.getByRole('tab', { name: /translate/i }).click()
  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await shot(page, 'translate-recording')

  send({ type: 'phase', capture: 'paused', engine: 'idle' })
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
  await shot(page, 'translate-paused')

  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  send({ type: 'phase', capture: 'off', engine: 'idle' })
  await page.waitForTimeout(600)
  await shot(page, 'translate-after-stop')
})

test('narrow 320', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/app')
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeVisible()
  await shot(page, 'listen-ready')

  const { send } = await mockWs(page)
  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  await expect(page.locator('.iphone-live-bar')).toBeVisible()
  await shot(page, 'listen-recording')
})
