import { test, expect } from '@playwright/test'
import type { WebSocketRoute } from 'playwright'
import { mkdirSync } from 'node:fs'

/**
 * Think (#182) — the Live Q&A switch, the value a submit carries, and the
 * sources block under the answer.
 *
 * Same harness as the other specs: the page runs with a fully mocked WebSocket
 * and the `?demo=interview` seed, so CI never reaches a provider and every event
 * below is deterministic. The frames the client sends are read off the routed
 * socket, which is the real submit path (bridge -> WS), not an internal call.
 *
 *   npx playwright test e2e/think.spec.ts
 */

const SHOTS = '../docs/design/think-182'

type Frame = Record<string, unknown>

async function mockWs(page: import('@playwright/test').Page, url = '/app?demo=interview') {
  const sent: Frame[] = []
  let route: WebSocketRoute | undefined
  await page.routeWebSocket(/\/ws$/, (ws) => {
    route = ws
    ws.onMessage((message) => {
      try {
        sent.push(JSON.parse(String(message)))
      } catch {
        /* non-JSON frames are not this spec's business */
      }
    })
  })
  await page.goto(url)
  await expect.poll(() => route !== undefined, { timeout: 5000 }).toBe(true)
  const send = (ev: Frame) => {
    if (!route) throw new Error('websocket not connected')
    route.send(JSON.stringify(ev))
  }
  return { sent, send }
}

function shot(page: import('@playwright/test').Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  return page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test.describe('Think switch', () => {
  test('keeps the inline switch above the input off-phone, defaults to off, and is absent elsewhere', async ({ page }) => {
    await mockWs(page)

    const toggle = page.getByRole('switch', { name: 'Think' })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toHaveText(/^Think$/)
    await expect(toggle.locator('.think-switch')).toBeVisible()
    await expect(toggle.locator('.think-dot')).toHaveCount(0)

    // Wider layouts keep the switch inline: ABOVE the existing input, which stays
    // visible and unchanged. The phone moves it into the recording chrome instead
    // (the phone-viewport test below).
    const toggleBox = await toggle.boundingBox()
    const inputBox = await page.locator('.prompt-input').boundingBox()
    expect(toggleBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(toggleBox!.y).toBeLessThan(inputBox!.y)
    await expect(page.locator('.think-row')).toBeVisible()
    await expect(page.locator('.prompt-input')).toBeVisible()
    await shot(page, 'interview-think-off')

    // Translate has no Live Q&A input, so the switch must not appear there.
    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByRole('switch', { name: 'Think' })).toHaveCount(0)
  })

  test('carries its value onto the submit, and New puts it back to off', async ({ page }) => {
    const { sent, send } = await mockWs(page)
    const toggle = page.getByRole('switch', { name: 'Think' })

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(sent.filter((m) => m.type === 'ask')).toHaveLength(0)
    await expect
      .poll(() => sent.filter((m) => m.type === 'set_think').length, {
        message: 'the switch must reach the server',
      })
      .toBeGreaterThan(0)
    const setThink = sent.filter((m) => m.type === 'set_think')
    expect(setThink[setThink.length - 1].on).toBe(true)
    await shot(page, 'interview-think-on')

    // A question submitted now goes out with the value it was submitted under, and
    // with the identity of that one submit action (the server's dedupe key).
    await page.locator('.prompt-input').fill('what is new?')
    await page.locator('.prompt-input').press('Enter')
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    expect(sent.filter((m) => m.type === 'ask')[0].think).toBe(true)
    const firstSubmitId = sent.filter((m) => m.type === 'ask')[0].submit_id
    expect(typeof firstSubmitId).toBe('string')
    expect(firstSubmitId).not.toBe('')

    // Finish that answer so the composer is free again (a real server would send
    // these; the mocked one must too, or the next submit is blocked by `busy`).
    send({ type: 'question', id: 'q1', text: 'what is new?' })
    send({ type: 'chunk', id: 'q1', text: 'ok' })
    send({ type: 'done', id: 'q1', stt: 0, llm: 1, ok: true })
    await expect(toggle).toBeEnabled()

    // Flip it off: the NEXT submit carries the new value.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.locator('.prompt-input').fill('and now?')
    await page.locator('.prompt-input').press('Enter')
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(2)
    expect(sent.filter((m) => m.type === 'ask')[1].think).toBe(false)
    expect(sent.filter((m) => m.type === 'ask')[1].submit_id).not.toBe(firstSubmitId)

    // New / clear starts a fresh session: back to the default. (The shortcut is
    // ignored while a text field has focus, exactly like the app intends.)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.locator('.prompt-input').blur()
    await page.keyboard.press('F4')
    // The session has content, so New asks first — confirm it.
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  test('follows the server when a session reset turns the switch off', async ({ page }) => {
    // #182 review: the server used to reset Think silently while the client kept
    // showing "on", so the next question looked like it would search and did not.
    // The reset is announced, and the client follows it.
    const { send } = await mockWs(page)
    const toggle = page.getByRole('switch', { name: 'Think' })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    send({ type: 'think', on: false })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})

/**
 * #182 review: the two submit paths the unit tests could not reach — the page's
 * attachment-only submit (which used to send a placeholder as the question and make
 * the server search for it) and the Live Q&A Retry entry (which did not exist).
 */
test.describe('Think submit identity', () => {
  test('an attachment-only submit carries no question text', async ({ page }) => {
    // The upload endpoint itself is not this test's subject.
    await page.route('**/api/attach/extract', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"attach-1"}' }),
    )
    const { sent, send } = await mockWs(page)
    await page.locator('.prompt-row input[type=file]').setInputFiles({
      name: 'payroll.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PRIVATE PAYROLL'),
    })
    const answer = page.locator('.gen-btn')
    await expect(answer).toBeEnabled()
    await answer.click()

    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    const frame = sent.filter((m) => m.type === 'ask')[0]
    // The placeholder the card shows must NOT be the question that gets searched.
    expect(frame.text).toBe('')
    expect(frame.attach_id).toBe('attach-1')
    expect(frame.think).toBe(false)
    expect(typeof frame.submit_id).toBe('string')
    expect(frame.submit_id).not.toBe('')

    // The server answers with the display title; Retry must still send the empty
    // question plus the same attachment, never the title.
    send({ type: 'question', id: 'q-attach-only', text: 'Please review: payroll.txt' })
    send({ type: 'chunk', id: 'q-attach-only', text: 'ok' })
    send({ type: 'done', id: 'q-attach-only', stt: 0, llm: 1, ok: true })
    await page.locator('.qa-ai-card').last().getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(2)
    const retry = sent.filter((m) => m.type === 'ask')[1]
    expect(retry.text).toBe('')
    expect(retry.attach_id).toBe('attach-1')
    expect(retry.retry_of).toBe('q-attach-only')
  })

  test('Retry rebuilds the original submission, attachments included', async ({ page }) => {
    await page.route('**/api/attach/extract', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"attach-1"}' }),
    )
    const { sent, send } = await mockWs(page)
    await page.locator('.prompt-row input[type=file]').setInputFiles({
      name: 'payroll.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PRIVATE PAYROLL'),
    })
    await page.locator('.prompt-input').fill('how is the bonus computed?')
    const answer = page.locator('.gen-btn')
    await expect(answer).toBeEnabled()
    await answer.click()
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    expect(sent.filter((m) => m.type === 'ask')[0].text).toBe('how is the bonus computed?')

    // The server labels the card with the file name, so the display title is NOT the
    // question that was searched.
    send({ type: 'question', id: 'q-attach-text', text: 'how is the bonus computed? (payroll.txt)' })
    send({ type: 'chunk', id: 'q-attach-text', text: 'ok' })
    send({ type: 'done', id: 'q-attach-text', stt: 0, llm: 1, ok: true })

    await page.locator('.qa-ai-card').last().getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(2)
    const retry = sent.filter((m) => m.type === 'ask')[1]
    expect(retry.text).toBe('how is the bonus computed?')
    expect(retry.attach_id).toBe('attach-1')
    expect(retry.retry_of).toBe('q-attach-text')
    expect(retry.mode).toBe('ask')
  })

  test('an upload in flight does not hand its attachment to a voice question', async ({ page }) => {
    // #182 review: the answer used to be bound to whichever card was pending, so a
    // voice question committed while an attachment submit was still uploading took
    // that submit's payload — and its Retry then re-sent the attachment question.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    await page.route('**/api/attach/extract', async (route) => {
      await gate
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"attach-1"}' })
    })
    const { sent, send } = await mockWs(page)
    await page.locator('.prompt-row input[type=file]').setInputFiles({
      name: 'payroll.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PRIVATE PAYROLL'),
    })
    await page.locator('.prompt-input').fill('how is the bonus computed?')
    await page.locator('.gen-btn').click() // the upload is now held

    // A voice question is committed while that upload is still in flight.
    send({ type: 'question', id: 'q-voice', text: 'what did they say about pricing?', submit_id: 'qa-voice' })
    send({ type: 'chunk', id: 'q-voice', text: 'ok' })
    send({ type: 'done', id: 'q-voice', stt: 0, llm: 1, ok: true })

    release!()
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    const attach = sent.filter((m) => m.type === 'ask')[0]
    send({
      type: 'question',
      id: 'q-attach',
      text: 'how is the bonus computed? (payroll.txt)',
      submit_id: attach.submit_id,
    })
    send({ type: 'chunk', id: 'q-attach', text: 'ok' })
    send({ type: 'done', id: 'q-attach', stt: 0, llm: 1, ok: true })

    // The voice card retries the VOICE question — not the attachment submit.
    const voiceCard = page.locator('.qa-result').filter({ hasText: 'what did they say about pricing?' })
    await voiceCard.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(2)
    const retry = sent.filter((m) => m.type === 'ask')[1]
    expect(retry.text).toBe('what did they say about pricing?')
    expect(retry.attach_id).toBeUndefined()
    expect(retry.retry_of).toBe('q-voice')
  })

  test('a question whose session was cleared before it was sent never searches', async ({ page }) => {
    // #182 review: the send happened after the upload await with no session check, so
    // a New / clear that landed during the upload was ignored and the old question
    // still reached the server (and, with Think on, searched).
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    await page.route('**/api/attach/extract', async (route) => {
      await gate
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"attach-1"}' })
    })
    const { sent } = await mockWs(page)
    await page.locator('.prompt-row input[type=file]').setInputFiles({
      name: 'payroll.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PRIVATE PAYROLL'),
    })
    await page.locator('.gen-btn').click() // the upload is now held

    // New lands while the upload is still in flight.
    await page.keyboard.press('F4')
    await page.getByRole('button', { name: 'Clear', exact: true }).click()

    release!()
    await page.waitForTimeout(500)
    expect(sent.filter((m) => m.type === 'ask')).toEqual([])
  })

  test('an upload that fails after the session moved on changes nothing', async ({ page }) => {
    // #182 review: only the success path checked the session, so an upload that
    // failed after a New still dispatched its failure — and the reducer wrote it into
    // whichever card was asking, plus forced `busy: false` and the status line.
    let failUpload: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      failUpload = () => resolve()
    })
    await page.route('**/api/attach/extract', async (route) => {
      await gate
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' })
    })
    const { sent, send } = await mockWs(page)
    await page.locator('.prompt-row input[type=file]').setInputFiles({
      name: 'payroll.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PRIVATE PAYROLL'),
    })
    await page.locator('.gen-btn').click() // held

    // New lands, and a fresh question is already being answered.
    await page.keyboard.press('F4')
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await page.locator('.prompt-input').fill('a fresh question?')
    await page.locator('.prompt-input').press('Enter')
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    const fresh = sent.filter((m) => m.type === 'ask')[0]

    failUpload!()
    await page.waitForTimeout(400)

    send({ type: 'question', id: 'q-fresh', text: 'a fresh question?', submit_id: fresh.submit_id })
    send({ type: 'chunk', id: 'q-fresh', text: ' the fresh answer' })
    send({ type: 'done', id: 'q-fresh', stt: 0, llm: 1, ok: true })

    const card = page.locator('.qa-result').filter({ hasText: 'a fresh question?' })
    await expect(card).toContainText('the fresh answer')
    await expect(page.getByText('Could not send the file')).toHaveCount(0)
    await expect(page.getByText('Could not resend the file')).toHaveCount(0)
  })

  test('a failed voice question keeps its error off the pending attachment card', async ({ page }) => {
    // #182 review: an error frame had no id, so the reducer wrote it into the first
    // card without an answer — an attachment submit still uploading.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    await page.route('**/api/attach/extract', async (route) => {
      await gate
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"attach-1"}' })
    })
    const { sent, send } = await mockWs(page)
    await page.locator('.prompt-row input[type=file]').setInputFiles({
      name: 'payroll.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PRIVATE PAYROLL'),
    })
    await page.locator('.prompt-input').fill('how is the bonus computed?')
    await page.locator('.gen-btn').click() // held

    send({ type: 'question', id: 'q-voice', text: 'what did they say about pricing?', submit_id: 'qa-voice' })
    send({ type: 'error', id: 'q-voice', text: 'Generation failed: boom' })
    send({ type: 'done', id: 'q-voice', stt: 0, llm: 1, ok: false })
    // A generic error belongs to no question at all.
    send({ type: 'error', text: 'Transcription connection lost. Tap Start Listening.' })

    release!()
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    const attach = sent.filter((m) => m.type === 'ask')[0]
    send({
      type: 'question',
      id: 'q-attach',
      text: 'how is the bonus computed? (payroll.txt)',
      submit_id: attach.submit_id,
    })
    send({ type: 'chunk', id: 'q-attach', text: 'The bonus is 10%.' })
    send({ type: 'done', id: 'q-attach', stt: 0, llm: 1, ok: true })

    const voiceCard = page.locator('.qa-result').filter({ hasText: 'what did they say about pricing?' })
    const attachCard = page.locator('.qa-result').filter({ hasText: 'how is the bonus computed?' })
    await expect(voiceCard).toContainText('Generation failed: boom')
    await expect(attachCard).toContainText('The bonus is 10%.')
    await expect(attachCard).not.toContainText('Generation failed')
    await expect(attachCard).not.toContainText('Transcription connection lost')
  })

  test('Copy keeps the sources and the retrieval time', async ({ page, context }) => {
    // #182 review: the live Copy entry copied only the answer body, so a Think answer
    // lost its 出处 even though History export kept it.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const { send } = await mockWs(page)
    send({ type: 'question', id: 'q-copy', text: 'What did Apple announce?' })
    send({ type: 'chunk', id: 'q-copy', text: 'A new model.' })
    send({
      type: 'sources',
      id: 'q-copy',
      status: 'ok',
      retrieved_at: 1789012800,
      retrieved_at_text: '2026-09-10 04:00 UTC',
      results: [{ title: 'Apple News', url: 'https://example.com/apple', published_at: '2026-09-10' }],
      note: '',
    })
    send({ type: 'done', id: 'q-copy', stt: 0, llm: 1, ok: true })
    await expect(page.locator('.qa-result').filter({ hasText: 'A new model.' })).toBeVisible()

    await page.locator('.prompt-input').blur()
    await page.keyboard.press('c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('A new model.')
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip).toContain('https://example.com/apple')
    expect(clip).toContain('检索时间：2026-09-10 04:00 UTC')
  })

  test('a turn without a live submission offers no Retry', async ({ page }) => {
    // #182 review: a restored/history turn has neither the Think value the question
    // ran with nor the attachments it was made of, so re-asking it would silently
    // change the question. The demo seed is the same shape as a restored turn.
    const { send } = await mockWs(page)
    const seeded = page.locator('.qa-result').filter({ hasText: 'New Zealand' })
    await expect(seeded.getByRole('button', { name: 'Retry' })).toHaveCount(0)

    // A live question in the same session still gets one.
    send({ type: 'question', id: 'q-live', text: 'what is new?', submit_id: 's-live' })
    send({ type: 'chunk', id: 'q-live', text: 'ok' })
    send({ type: 'done', id: 'q-live', stt: 0, llm: 1, ok: true })
    const live = page.locator('.qa-result').filter({ hasText: 'what is new?' })
    await expect(live.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  test('Retry re-asks with the Think value the question ran with', async ({ page }) => {
    const { sent, send } = await mockWs(page)
    const toggle = page.getByRole('switch', { name: 'Think' })
    await toggle.click()
    await page.locator('.prompt-input').fill('what is new?')
    await page.locator('.prompt-input').press('Enter')
    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(1)
    const firstSubmitId = sent.filter((m) => m.type === 'ask')[0].submit_id

    // The server answers, echoing the value the question ran with.
    send({ type: 'question', id: 'q-retry', text: 'what is new?', think: true })
    send({ type: 'chunk', id: 'q-retry', text: 'ok' })
    send({ type: 'done', id: 'q-retry', stt: 0, llm: 1, ok: true })

    // The demo seed already shows one answered card, so scope to the newest one.
    const retry = page.locator('.qa-ai-card').last().getByRole('button', { name: 'Retry' })
    await expect(retry).toBeVisible()

    // The switch is off for the NEXT question; the retry still runs as the original
    // did, and names the answer it retries so the server can reuse that lookup.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await retry.click()

    await expect.poll(() => sent.filter((m) => m.type === 'ask').length).toBe(2)
    const frame = sent.filter((m) => m.type === 'ask')[1]
    expect(frame.think).toBe(true)
    expect(frame.retry_of).toBe('q-retry')
    expect(frame.mode).toBe('ask')
    expect(frame.submit_id).not.toBe(firstSubmitId)
  })
})

test.describe('Think answer rendering', () => {
  test('shows the real sources and the retrieval time, and nothing extra for a plain answer', async ({ page }) => {
    const { send } = await mockWs(page)

    send({ type: 'question', id: 'q-think', text: 'What did Apple announce?' })
    send({ type: 'chunk', id: 'q-think', text: 'A new model.' })
    send({
      type: 'sources',
      id: 'q-think',
      status: 'ok',
      retrieved_at: 1789012800,
      retrieved_at_text: '2026-09-10 04:00 UTC',
      results: [{ title: 'Apple News', url: 'https://example.com/apple', published_at: '2026-09-10' }],
      note: '',
    })
    send({ type: 'done', id: 'q-think', stt: 0, llm: 1, ok: true })

    const link = page.getByRole('link', { name: 'Apple News' })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'https://example.com/apple')
    await expect(page.getByText('检索时间：2026-09-10 04:00 UTC')).toBeVisible()
    await expect(page.getByText(/2026-09-10/).first()).toBeVisible()
    await shot(page, 'interview-sources')

    // A lookup that did not run says so instead of showing sources.
    send({ type: 'question', id: 'q-empty', text: 'Anything at all?' })
    send({ type: 'chunk', id: 'q-empty', text: 'An answer without retrieval.' })
    send({
      type: 'sources',
      id: 'q-empty',
      status: 'failed',
      retrieved_at: 1789012801,
      retrieved_at_text: '2026-09-10 04:00 UTC',
      results: [],
      note: '联网检索失败（TimeoutError），本次回答未使用最新检索资料。',
    })
    send({ type: 'done', id: 'q-empty', stt: 0, llm: 1, ok: true })
    await expect(page.getByText('联网检索失败（TimeoutError），本次回答未使用最新检索资料。')).toBeVisible()

    // A plain answer (no sources event at all) must not grow an empty block.
    send({ type: 'question', id: 'q-plain', text: 'Plain question?' })
    send({ type: 'chunk', id: 'q-plain', text: 'Plain answer.' })
    send({ type: 'done', id: 'q-plain', stt: 0, llm: 1, ok: true })
    await expect(page.getByText('Plain answer.')).toBeVisible()
    // The seeded demo turns have none either: exactly the two answers above show a block.
    await expect(page.locator('.qa-sources')).toHaveCount(2)
  })
})

/**
 * Phone-width before/after evidence (#219: the Think switch belongs to the
 * recording chrome, not the composer). The on-screen keyboard itself is a native
 * overlay a browser cannot draw — the layout side of that is covered by the
 * `keyboardInset` unit test — so these shots pin the phone layout itself.
 */
test.describe('Think on a phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('sits under End, right of the mode line, off and on', async ({ page }) => {
    const { sent, send } = await mockWs(page)
    // A phone only shows the recording chrome and the mode line inside a live
    // session: on the Ready screen there is no End button to sit under.
    send({ type: 'phase', capture: 'listening', engine: 'idle' })
    const toggle = page.getByRole('switch', { name: 'Think' })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    // Exactly one switch: the composer must not keep a second, bottom copy.
    await expect(page.getByRole('switch', { name: 'Think' })).toHaveCount(1)
    await expect(page.locator('.listen-qa .think-row')).toHaveCount(0)
    await expect(page.locator('.iphone-meta-row .think-toggle')).toHaveCount(1)

    const toggleBox = await toggle.boundingBox()
    const endBox = await page.locator('.iphone-rec-end').boundingBox()
    const metaBox = await page.locator('.iphone-meta-row .iphone-meta').boundingBox()
    const rowBox = await page.locator('.iphone-meta-row').boundingBox()
    expect(toggleBox).not.toBeNull()
    expect(endBox).not.toBeNull()
    expect(metaBox).not.toBeNull()
    expect(rowBox).not.toBeNull()
    // Under the End button (the recording bar is directly above this row) ...
    expect(toggleBox!.y).toBeGreaterThanOrEqual(endBox!.y + endBox!.height)
    // ... on the SAME line as the mode description: left text, right switch ...
    expect(metaBox!.x + metaBox!.width).toBeLessThanOrEqual(toggleBox!.x)
    expect(Math.abs((metaBox!.y + metaBox!.height / 2) - (toggleBox!.y + toggleBox!.height / 2))).toBeLessThan(12)
    // ... and right-aligned inside the row, with a >=44 pt touch target.
    expect(toggleBox!.x).toBeGreaterThan(rowBox!.x + rowBox!.width / 2)
    expect(toggleBox!.height).toBeGreaterThanOrEqual(44)
    // The app asks for mic access when the mocked recorder starts; a browser
    // without one leaves its "Microphone access needed" toast over the top bar
    // for 2 s. It is unrelated to this switch, so let it clear before the shot.
    await page.waitForTimeout(2400)
    await shot(page, 'phone-think-off')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    // Toggling is not a submit.
    expect(sent.filter((m) => m.type === 'ask')).toHaveLength(0)
    await shot(page, 'phone-think-on')
  })

  test('keeps the switch reachable while Live Q&A shows editable settings', async ({ page }) => {
    // Live Q&A entered from a meeting that already has lines: capture is off, so
    // the phone shows the editable chips instead of the mode line — but the Q&A
    // composer is still on screen, so the switch must not disappear with the old
    // composer placement.
    await mockWs(page, '/app?demo=meeting')
    await page.getByRole('button', { name: /^Meeting/ }).click()
    await page.getByRole('option', { name: /Live Q&A/ }).click()
    await expect(page.locator('.prompt-input')).toBeVisible()
    const toggle = page.getByRole('switch', { name: 'Think' })
    await expect(toggle).toBeVisible()
    await expect(page.locator('.iphone-meta-row .think-toggle')).toHaveCount(1)
    await expect(page.locator('.iphone-meta')).toHaveCount(0)
    await expect(page.locator('.listen-qa .think-row')).toHaveCount(0)
  })
})
