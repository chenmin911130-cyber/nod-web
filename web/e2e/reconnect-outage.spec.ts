import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

const WS_PATTERN = /\/ws(\?.*)?$/
const LOST = 'Lost connection to Nodpilot. Reload the page to reconnect.'

function armListening(send: (msg: Record<string, unknown>) => void) {
  send({ type: 'ready' })
  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  send({ type: 'audio_uplink', token: 't1' })
}

async function mockListenWithOutage(page: import('@playwright/test').Page) {
  let blockNew = false
  let active: WebSocketRoute | undefined
  let attemptCount = 0
  const attemptUrls: string[] = []

  await page.routeWebSocket(WS_PATTERN, (route) => {
    attemptCount += 1
    attemptUrls.push(route.url())
    if (blockNew) {
      route.close()
      return
    }
    active = route
  })

  const send = (msg: Record<string, unknown>) => {
    if (!active) throw new Error('websocket not connected')
    active.send(JSON.stringify(msg))
  }

  await page.goto('/app?demo=meeting')
  await expect.poll(() => active !== undefined, { timeout: 5000 }).toBe(true)
  armListening(send)
  await expect(page.locator('.iphone-live-bar')).toBeVisible()

  const waitForAttachUrl = async () => {
    active?.close()
    active = undefined
    await expect.poll(() => attemptUrls.some((u) => u.includes('attach=t1')), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => active !== undefined, { timeout: 10_000 }).toBe(true)
  }

  return {
    send,
    get attemptCount() {
      return attemptCount
    },
    get active() {
      return active
    },
    get attemptUrls() {
      return attemptUrls
    },
    set blockNew(v: boolean) {
      blockNew = v
    },
    closeActive() {
      active?.close()
      active = undefined
    },
    waitForAttachUrl,
  }
}

test.describe('Control WS reconnect during listen outage (T64 / H)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('keeps retrying through long outage and re-attaches with uplink token', async ({ page }) => {
    const mock = await mockListenWithOutage(page)
    await mock.waitForAttachUrl()

    mock.blockNew = true
    mock.closeActive()

    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
    for (let i = 0; i < 70; i += 1) {
      await page.clock.runFor(5000)
      await page.waitForTimeout(50)
    }
    expect(mock.attemptCount).toBeGreaterThan(12)

    mock.blockNew = false
    const attemptsBeforeRecovery = mock.attemptCount
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.clock.runFor(15_000)
    await page.waitForTimeout(50)

    await expect.poll(() => mock.attemptCount > attemptsBeforeRecovery && mock.active !== undefined).toBe(true)
    expect(mock.attemptUrls.some((u) => u.includes('attach=t1'))).toBe(true)
    await expect(page.getByText(LOST)).toHaveCount(0)
  })

  test('online event triggers immediate reconnect attempt', async ({ page }) => {
    const mock = await mockListenWithOutage(page)
    await mock.waitForAttachUrl()

    mock.blockNew = true
    mock.closeActive()
    const before = mock.attemptCount

    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => mock.attemptCount > before, { timeout: 1000 }).toBe(true)
  })

  test('three online events while connecting open only one new socket', async ({ page }) => {
    const mock = await mockListenWithOutage(page)
    await mock.waitForAttachUrl()

    mock.blockNew = true
    mock.closeActive()
    const before = mock.attemptCount

    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('online'))
    })
    await page.waitForTimeout(500)
    expect(mock.attemptCount - before).toBe(1)
  })
})
