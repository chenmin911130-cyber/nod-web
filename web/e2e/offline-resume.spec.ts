import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

const OFFLINE_STOP =
  'Listening stopped — the phone was offline for more than 120 seconds.'

async function mockListenWs(page: import('@playwright/test').Page, url = '/app?demo=meeting') {
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
  return {
    send,
    async gotoListening() {
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

function continueBeforeSaveBanner(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const cont = document.querySelector('.iphone-bar-ended .iphone-bar-primary')
    const save = document.querySelector('.save-banner b')
    if (!cont || !save) return null
    return Boolean(cont.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
}

function saveBannerBeforeContinue(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const cont = document.querySelector('.iphone-bar-ended .iphone-bar-primary')
    const save = document.querySelector('.save-banner b')
    if (!cont || !save) return null
    return Boolean(cont.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_PRECEDING)
  })
}

test.describe('Offline stop resume hint (T64)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('offline stop shows hint with Continue before save banner', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'question', id: 'm1', text: 'Hello from the meeting.' })
    ws.send({ type: 'phase', capture: 'off', engine: 'idle' })
    ws.send({ type: 'status', text: OFFLINE_STOP })
    ws.send({ type: 'save_prompt', id: 'sess-offline-1', mode: 'meeting' })
    await expect(page.getByText('Back online — tap Continue to keep recording')).toBeVisible()
    await expect(page.getByText('Save this session?')).toBeVisible()
    await expect.poll(() => continueBeforeSaveBanner(page)).toBe(true)
  })

  test('Continue clears the offline resume hint', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'question', id: 'm1', text: 'Hello from the meeting.' })
    ws.send({ type: 'phase', capture: 'off', engine: 'idle' })
    ws.send({ type: 'status', text: OFFLINE_STOP })
    ws.send({ type: 'save_prompt', id: 'sess-offline-2', mode: 'meeting' })
    await expect(page.getByText('Back online — tap Continue to keep recording')).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await expect(page.getByText('Back online — tap Continue to keep recording')).toHaveCount(0)
  })

  test('normal End keeps save banner before Continue without hint', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'question', id: 'm1', text: 'Normal end session.' })
    await ws.endSession()
    ws.send({ type: 'save_prompt', id: 'sess-normal-1', mode: 'meeting' })
    await expect(page.getByText('Save this session?')).toBeVisible()
    await expect(page.getByText('Back online — tap Continue to keep recording')).toHaveCount(0)
    await expect.poll(() => saveBannerBeforeContinue(page)).toBe(true)
  })

  test('restoring another session from History clears the offline hint', async ({ page }) => {
    const offlineLiveId = 'sess-offline-hist-live'
    const otherSession = {
      id: 'sess-history-other',
      mode: 'meeting',
      scene: 'meeting',
      title: 'Prior standup notes',
      started_at: '2026-01-15T10:00:00Z',
      ended_at: '2026-01-15T10:30:00Z',
      stt_seconds: 120,
      kept: true,
      items: [{ kind: 'transcript', text: 'We agreed to ship on Tuesday.' }],
    }
    await page.route('**/api/account/history**', async (route) => {
      const url = route.request().url()
      if (url.includes('pending=1')) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessions: [] }) })
        return
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessions: [otherSession] }) })
    })

    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'question', id: 'm1', text: 'Offline stop on this session.' })
    ws.send({ type: 'phase', capture: 'off', engine: 'idle' })
    ws.send({ type: 'status', text: OFFLINE_STOP })
    ws.send({ type: 'save_prompt', id: offlineLiveId, mode: 'meeting' })
    await expect(page.getByText('Back online — tap Continue to keep recording')).toBeVisible()

    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.getByRole('dialog', { name: 'History' })).toBeVisible()
    await page.getByRole('button', { name: /Prior standup notes/i }).click()

    await expect(page.getByText('Back online — tap Continue to keep recording')).toHaveCount(0)
    await expect(page.getByText('Save this session?')).toHaveCount(0)
    await expect(page.getByText('We agreed to ship on Tuesday.')).toBeVisible()
  })
})
