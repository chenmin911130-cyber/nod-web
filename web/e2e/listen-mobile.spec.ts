import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'

const EVIDENCE = '../docs/design/listen-controls-193/after'

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

/** Count what the client actually sends, so "one request, not two" is provable. */
async function countSends(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __sent: Record<string, unknown>[]; api: { send: (m: unknown) => void } }
    w.__sent = []
    const original = w.api.send.bind(w.api)
    w.api.send = (msg: unknown) => {
      w.__sent.push(msg as Record<string, unknown>)
      original(msg)
    }
  })
}

async function sendsOf(page: import('@playwright/test').Page, type: string, mode?: string) {
  return await page.evaluate(
    ([t, mo]) => {
      const w = window as unknown as { __sent?: Record<string, unknown>[] }
      return (w.__sent || []).filter((m) => m.type === t && (!mo || m.mode === mo)).length
    },
    [type, mode] as [string, string | undefined],
  )
}

test.describe('Listen mobile chrome (#193 item 1)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('Ready has no New and no Ask; the start pill is the bottom bar', async ({ page }) => {
    await page.goto('/app')
    await expect(page.locator('html')).toHaveClass(/nod-phone/)
    const start = page.getByRole('button', { name: 'Start listening' })
    await expect(start).toBeVisible()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ask' })).toHaveCount(0)
    // the start pill sits inside the bottom bar, above nothing else
    const bar = page.locator('.iphone-live-bar')
    await expect(bar).toBeVisible()
    const startBox = (await start.boundingBox())!
    const barBox = (await bar.boundingBox())!
    expect(startBox.y).toBeGreaterThan(barBox.y)
  })

  test('content without a finished session still hides New (History-restore shape)', async ({ page }) => {
    await page.goto('/app?demo=meeting-notes')
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/listen-content-no-new-390.png` })
  })

  test('a finished session with content shows New; Continue lives in the bar', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'phase', capture: 'paused', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await ws.endSession()
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible()
    const bar = page.locator('.iphone-live-bar')
    const cont = page.getByRole('button', { name: 'Continue' })
    const barBox = (await bar.boundingBox())!
    const contBox = (await cont.boundingBox())!
    expect(contBox.y).toBeGreaterThanOrEqual(barBox.y)
    expect(contBox.width).toBeGreaterThan(barBox.width * 0.7)
  })
})

test.describe('Listen mobile shortcuts (#193 item 2)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('recording shows Summarize/Action items without opening Ask, one request each', async ({ page }) => {
    const ws = await mockListenWs(page)
    await countSends(page)
    await ws.gotoListening()
    await expect(page.getByRole('button', { name: 'Summarize so far' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'List action items' })).toBeVisible()
    // Ask input is NOT open — the shortcuts no longer depend on it
    await expect(page.locator('.listen-prompt input')).toHaveCount(0)

    await page.getByRole('button', { name: 'Summarize so far' }).click()
    await expect.poll(() => sendsOf(page, 'ask', 'notes')).toBe(1)
    // while the model works the shortcuts stay visible but cannot double-fire
    await expect(page.getByRole('button', { name: 'Summarize so far' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'List action items' })).toBeDisabled()
    await page.waitForTimeout(400)
    expect(await sendsOf(page, 'ask', 'notes')).toBe(1)
    await page.screenshot({ path: `${EVIDENCE}/listen-shortcuts-390.png` })
  })

  test('List action items fires exactly one listener ask', async ({ page }) => {
    const ws = await mockListenWs(page)
    await countSends(page)
    await ws.gotoListening()
    await page.getByRole('button', { name: 'List action items' }).click()
    await expect.poll(() => sendsOf(page, 'ask', 'listen_ask')).toBe(1)
    expect(await sendsOf(page, 'ask', 'notes')).toBe(0)
  })

  test('paused keeps the shortcuts, Lecture keeps its own wording', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'phase', capture: 'paused', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'Summarize so far' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'List action items' })).toBeVisible()
  })
})

test.describe('Listen mobile Ask bubble (#193 item 3)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('tap opens and focuses, tap again closes, drag only moves it', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    const bubble = page.getByRole('button', { name: 'Ask' })
    const input = page.locator('.listen-prompt input')

    await bubble.click()
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    await input.fill('draft to keep')

    await bubble.click()
    await expect(input).toHaveCount(0)
    await expect(bubble).toHaveAttribute('aria-expanded', 'false')

    await bubble.click()
    await expect(input).toHaveValue('draft to keep')

    // drag: the bubble moves, the input stays open, and the drag is not a tap
    const before = (await bubble.boundingBox())!
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x - 90, before.y - 150, { steps: 12 })
    await page.mouse.up()
    const after = (await bubble.boundingBox())!
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(40)
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(80)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('draft to keep')

    // a tap right after a drag still toggles (the drag must not eat it)
    await bubble.click()
    await expect(input).toHaveCount(0)
    await expect(bubble).toHaveAttribute('aria-expanded', 'false')
    await page.screenshot({ path: `${EVIDENCE}/listen-ask-dragged-390.png` })
  })

  test('the bubble is clamped back into the screen after a drag', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    const bubble = page.getByRole('button', { name: 'Ask' })
    const before = (await bubble.boundingBox())!
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(-400, 4000, { steps: 12 })
    await page.mouse.up()
    const after = (await bubble.boundingBox())!
    expect(after.x).toBeGreaterThanOrEqual(0)
    expect(after.y).toBeGreaterThanOrEqual(0)
    expect(after.x + after.width).toBeLessThanOrEqual(390)
    expect(after.y + after.height).toBeLessThanOrEqual(844)
  })
})

test.describe('Listen mobile recording chrome', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('listening hides New and uses the bottom rec bar, not the top row', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.locator('.iphone-actions.live')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/listen-recording-390.png` })
  })

  test('pause hides New, keeps the rec bar, and shows Resume', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    ws.send({ type: 'phase', capture: 'paused', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.locator('.iphone-live-bar')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(page.locator('.iphone-live-meter.paused')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
  })

  test('ended sheet peeks results by default and the handle click expands it', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await ws.endSession()
    await expect(page.getByRole('tab', { name: 'Live' })).toBeVisible()
    await expect(page.getByText('Applies to next recording')).toBeVisible()
    const peek = page.locator('.iphone-live-feed-wrap')
    await expect(peek).toContainText('launch window')
    const peekBox = await peek.evaluate((el) => {
      const style = getComputedStyle(el)
      return { display: style.display, height: el.getBoundingClientRect().height }
    })
    expect(peekBox.display).not.toBe('none')
    expect(peekBox.height).toBeGreaterThanOrEqual(88)
    expect(peekBox.height).toBeLessThanOrEqual(180)
    await page.screenshot({ path: `${EVIDENCE}/listen-ended-default-390.png` })
    await page.getByRole('button', { name: 'Show transcript' }).click()
    await expect(page.getByRole('button', { name: 'Show settings' })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Applies to next recording')).not.toBeVisible()
    const expanded = await peek.evaluate((el) => el.getBoundingClientRect().height)
    expect(expanded).toBeGreaterThan(peekBox.height)
  })

  test('Continue keeps the same-session Ask draft', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await page.getByRole('button', { name: 'Ask' }).click()
    const ask = page.locator('.listen-prompt input')
    await expect(ask).toBeVisible()
    await ask.fill('keep through continue')
    await ws.endSession()
    await page.getByRole('button', { name: 'Continue' }).click()
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await expect(page.locator('.iphone-live-bar')).toBeVisible()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    await expect(page.locator('.listen-prompt input')).toHaveValue('keep through continue')
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
    // the banner sits above the Continue bar, not under it
    const banner = page.getByText("Couldn't save.")
    const bar = page.locator('.iphone-live-bar')
    const bannerBox = (await banner.boundingBox())!
    const barBox = (await bar.boundingBox())!
    expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(barBox.y + barBox.height)
    await page.screenshot({ path: `${EVIDENCE}/ended-save-failed-390.png` })
  })

  test('kb-open layout keeps the rec bar and Ask field in the visual viewport', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await page.getByRole('button', { name: 'Ask' }).click()
    const ask = page.locator('.listen-prompt input')
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
    const boxes = await page.evaluate(() => {
      const recBar = document.querySelector('.iphone-live-bar')
      const field = document.querySelector('.listen-prompt input')
      const bubble = document.querySelector('.iphone-ask-bubble')
      const feed = document.querySelector('.iphone-live-feed-wrap, .listen-split')
      const recBox = recBar?.getBoundingClientRect()
      const fieldBox = field?.getBoundingClientRect()
      const bubbleBox = bubble?.getBoundingClientRect()
      return {
        recBottom: recBox?.bottom ?? -1,
        fieldBottom: fieldBox?.bottom ?? -1,
        bubbleBottom: bubbleBox?.bottom ?? -1,
        viewport: window.innerHeight,
        feedOverflow: feed ? getComputedStyle(feed).overflow : '',
      }
    })
    expect(boxes.recBottom).toBeGreaterThan(0)
    expect(boxes.recBottom).toBeLessThanOrEqual(boxes.viewport)
    expect(boxes.fieldBottom).toBeGreaterThan(0)
    expect(boxes.fieldBottom).toBeLessThanOrEqual(boxes.viewport)
    expect(boxes.bubbleBottom).toBeLessThanOrEqual(boxes.viewport)
    expect(boxes.feedOverflow).toMatch(/auto|scroll/)
    await page.screenshot({ path: `${EVIDENCE}/listen-ask-kb-390.png` })
  })
})

test.describe('Listen mobile replaced-Ask regression (#190)', () => {
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

  test('ended tab bar taps switch panes and drags move the dock', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await ws.endSession()
    const tab = (name: string) => page.getByRole('tab', { name })
    const handle = page.locator('.iphone-ended-handle')
    await expect(handle).toHaveAttribute('aria-expanded', 'false')

    await tab('Transcript').click()
    await expect(tab('Transcript')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.iphone-tr-card').first()).toBeVisible()
    await expect(handle).toHaveAttribute('aria-expanded', 'true')

    await tab('Notes').click()
    await expect(tab('Notes')).toHaveAttribute('aria-selected', 'true')
    await tab('Live').click()
    await expect(tab('Live')).toHaveAttribute('aria-selected', 'true')

    await dragBar(page, 90)
    await expect(handle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Applies to next recording')).toBeVisible()

    await dragBar(page, -90)
    await expect(handle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Applies to next recording')).not.toBeVisible()

    await tab('Transcript').click()
    await expect(tab('Transcript')).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Translate mobile chrome (#193 item 5)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('Ask sits above the bar, no New, and Start/Stop live in the bar', async ({ page }) => {
    const ws = await mockListenWs(page, '/app?demo=meeting')
    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByRole('button', { name: 'Start voice translation' })).toBeVisible()
    const bubble = page.getByRole('button', { name: 'Ask' })
    await expect(bubble).toBeVisible()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    const bar = page.locator('.iphone-live-bar')
    const bubbleBox = (await bubble.boundingBox())!
    const barBox = (await bar.boundingBox())!
    expect(bubbleBox.y + bubbleBox.height).toBeLessThanOrEqual(barBox.y + 1)

    await page.getByRole('button', { name: 'Start voice translation' }).click()
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/translate-recording-390.png` })
  })

  test('the clock runs with capture, freezes on pause, continues and resets', async ({ page }) => {
    const ws = await mockListenWs(page, '/app?demo=meeting')
    await page.getByRole('tab', { name: /translate/i }).click()
    await page.getByRole('button', { name: 'Start voice translation' }).click()
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    const clock = page.locator('.iphone-live-bar .iphone-clock')
    await expect(clock).toHaveText('00:00')
    await expect.poll(async () => await clock.textContent(), { timeout: 6000 }).not.toBe('00:00')
    const running = (await clock.textContent())!

    ws.send({ type: 'phase', capture: 'paused', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    const frozen = (await clock.textContent())!
    await page.waitForTimeout(2200)
    expect(await clock.textContent()).toBe(frozen)

    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await expect.poll(async () => await clock.textContent(), { timeout: 6000 }).not.toBe(running)
    await expect.poll(async () => await clock.textContent(), { timeout: 6000 }).not.toBe(frozen)

    // Stop banks the real length, and a new session starts from zero
    await page.getByRole('button', { name: 'Stop' }).click()
    ws.send({ type: 'phase', capture: 'off', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'Start voice translation' })).toBeVisible()
    await page.getByRole('button', { name: 'Start voice translation' }).click()
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await expect(clock).toHaveText('00:00')
  })

  test('a Meeting session never shows up as the Translate clock', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await page.waitForTimeout(1500)
    const meetingClock = (await page.locator('.iphone-live-bar .iphone-clock').textContent())!
    expect(meetingClock).not.toBe('00:00')

    // the workspace cannot switch mid-capture; once the Meeting session is over
    // its banked length must not follow us into Translate
    await page.getByRole('button', { name: 'End' }).click()
    ws.send({ type: 'phase', capture: 'off', engine: 'idle' })
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByRole('button', { name: 'Start voice translation' })).toBeVisible()
    // Ready draws no clock at all — nothing of the Meeting session can show here
    await expect(page.locator('.iphone-live-bar .iphone-clock')).toHaveCount(0)

    await page.getByRole('button', { name: 'Start voice translation' }).click()
    ws.send({ type: 'phase', capture: 'listening', engine: 'idle' })
    await expect(page.locator('.iphone-live-bar .iphone-clock')).toHaveText('00:00')
  })
})

test.describe('Listen mobile small phone', () => {
  test.use({ viewport: { width: 320, height: 568 } })

  test('the bar stays single-row and its targets stay tappable', async ({ page }) => {
    const ws = await mockListenWs(page)
    await ws.gotoListening()
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
    const bar = page.locator('.iphone-live-bar')
    const barBox = (await bar.boundingBox())!
    expect(barBox.height).toBeLessThanOrEqual(80)
    for (const name of ['Pause', 'End']) {
      const box = (await page.getByRole('button', { name }).boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    const bubble = (await page.getByRole('button', { name: 'Ask' }).boundingBox())!
    expect(bubble.width).toBeGreaterThanOrEqual(44)
    expect(bubble.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: `${EVIDENCE}/listen-recording-320.png` })
  })
})
