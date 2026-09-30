import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

type Sent = { type?: string; id?: string }

test.describe('Phone save banner and paused Save', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('End banner offers Don\'t save and Save', async ({ page }) => {
    const phone = await openPhone(page)
    await reachSaveBanner(page, phone.send)
    await expect(page.getByRole('button', { name: "Don't save" })).toBeVisible()
    await expect(page.locator('.save-banner-save')).toBeVisible()
  })

  test('Don\'t save discards once after 5 seconds', async ({ page }) => {
    const phone = await openPhone(page)
    await reachSaveBanner(page, phone.send)
    await page.getByRole('button', { name: "Don't save" }).click()
    await expect(page.getByText('Not saved')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
    await expect(page.getByRole('button', { name: "Don't save" })).toHaveCount(0)
    await expect(page.locator('.save-banner-save')).toHaveCount(0)
    await page.waitForTimeout(5500)
    expect(phone.discards).toEqual([{ type: 'discard_history', id: 's1' }])
    await expect(page.locator('.save-banner')).toHaveCount(0)
  })

  test('Undo within 5 seconds keeps the session and restores the banner', async ({ page }) => {
    const phone = await openPhone(page)
    await reachSaveBanner(page, phone.send)
    await page.getByRole('button', { name: "Don't save" }).click()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByRole('button', { name: "Don't save" })).toBeVisible()
    await expect(page.locator('.save-banner-save')).toBeVisible()
    await page.waitForTimeout(6000)
    expect(phone.discards).toEqual([])
  })

  test('New session during the countdown discards immediately and only once', async ({ page }) => {
    const phone = await openPhone(page)
    await reachSaveBanner(page, phone.send)
    await page.getByRole('button', { name: "Don't save" }).click()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
    await page.getByRole('button', { name: 'New session' }).click()
    await expect.poll(() => phone.discards.length).toBe(1)
    expect(phone.discards).toEqual([{ type: 'discard_history', id: 's1' }])
    await page.waitForTimeout(5500)
    expect(phone.discards).toEqual([{ type: 'discard_history', id: 's1' }])
  })

  test('Pause does not open the banner and More Save can keep the session', async ({ page }) => {
    const phone = await openPhone(page)
    phone.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    phone.send({ type: 'question', id: 'q1', text: 'First line of the meeting.' })
    phone.send({ type: 'question', id: 'q2', text: 'Second line of the meeting.' })
    await expect(page.getByText('Second line of the meeting.')).toBeVisible()
    phone.send({ type: 'phase', capture: 'paused', engine: 'idle' })
    phone.send({ type: 'listen_flush', id: '1', session_id: 's1', ok: true })
    await expect(page.locator('.save-banner')).toHaveCount(0)
    await page.getByRole('button', { name: 'More', exact: true }).click()
    const save = page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: /^Save/ })
    await expect(save).toBeEnabled()
    await save.click()
    const confirm = page.getByRole('dialog', { name: 'Save to History?' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => phone.keeps.length).toBe(1)
    expect(phone.keeps[0]).toMatchObject({ type: 'keep_history', id: 's1' })
  })

  test('Save stays disabled while recording', async ({ page }) => {
    const phone = await openPhone(page)
    phone.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    phone.send({ type: 'question', id: 'q1', text: 'First line of the meeting.' })
    await expect(page.getByText('First line of the meeting.')).toBeVisible()
    await page.getByRole('button', { name: 'More', exact: true }).click()
    const save = page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: /^Save/ })
    await expect(save).toBeDisabled()
  })
})

async function openPhone(page: import('@playwright/test').Page) {
  const discards: Sent[] = []
  const keeps: Sent[] = []
  let ws: WebSocketRoute | undefined
  await page.routeWebSocket(/\/ws$/, (route) => {
    ws = route
    route.onMessage((message) => {
      let m: Sent | null = null
      try { m = JSON.parse(String(message)) as Sent } catch { return }
      if (m?.type === 'discard_history') discards.push(m)
      if (m?.type === 'keep_history') keeps.push(m)
    })
  })
  await page.goto('/app')
  await expect.poll(() => ws !== undefined, { timeout: 5000 }).toBe(true)
  const send = (msg: Record<string, unknown>) => ws!.send(JSON.stringify(msg))
  return { send, discards, keeps }
}

async function reachSaveBanner(page: import('@playwright/test').Page, send: (msg: Record<string, unknown>) => void) {
  send({ type: 'phase', capture: 'listening', engine: 'idle' })
  send({ type: 'question', id: 'q1', text: 'First line of the meeting.' })
  send({ type: 'question', id: 'q2', text: 'Second line of the meeting.' })
  await expect(page.getByText('Second line of the meeting.')).toBeVisible()
  await page.getByRole('button', { name: 'End', exact: true }).click()
  send({ type: 'phase', capture: 'off', engine: 'idle' })
  send({ type: 'save_prompt', id: 's1', mode: 'meeting' })
  await expect(page.getByRole('button', { name: "Don't save" })).toBeVisible()
}
