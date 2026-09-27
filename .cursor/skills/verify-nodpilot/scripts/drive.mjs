#!/usr/bin/env node
// Scenario driver for verify-nodpilot. Invoked through `control-nod drive`.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'

const require = createRequire(join(process.env.NODE_PATH || '.', 'noop.js'))
const { chromium } = require('@playwright/test')

const BASE = process.env.NOD_BASE
const FAKE = process.env.NOD_FAKE
const RUN = process.env.NOD_RUN_DIR
const ADMIN = process.env.NOD_ADMIN_TOKEN
if (!BASE || !RUN) throw new Error('run through control-nod drive')
const PORT = new URL(BASE).port
// *.localhost is loopback and a secure context to Chromium, but non-local to the app
// (client isLocalHost and server is_local_scope), so each user is a real signed-in account.
const ISOLATED_BASE = `http://nod.localhost:${PORT}`

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 860 }

class Check {
  constructor(id, dir) { this.id = id; this.dir = dir; this.steps = []; this.status = 'PASS'; this.notes = []; this.open = [] }
  ok(cond, what) { this.steps.push({ ok: !!cond, what }); if (!cond) this.status = 'FAIL'; return !!cond }
  note(s) { this.notes.push(s) }
  blocked(s) { if (this.status === 'PASS') this.status = 'NOT VERIFIABLE'; this.notes.push(`needs: ${s}`) }
}

// node:http rather than fetch: fetch silently drops a custom Host header.
function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { ...headers }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (payload !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload) }
  if (token) h.authorization = `Bearer ${token}`
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (text += d))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}
const REMOTE = { host: `nod.localhost:${PORT}` }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let userSeq = 0
async function newUser(tag) {
  const email = `verify-${tag}-${Date.now().toString(36)}-${userSeq++}@example.test`
  for (let i = 0; i < 8; i++) {
    const r = await api('/api/auth/register', { method: 'POST', body: { email, password: 'verify-pass-123', consent: true } })
    if (r.status === 200) return { email, token: r.json.token, id: r.json.user?.id }
    if (r.status !== 429) throw new Error(`register ${r.status} ${r.text.slice(0, 120)}`)
    await sleep(10000)
  }
  throw new Error('register rate-limited for 80s')
}

// isolated=true: fresh registered user on ISOLATED_BASE. isolated=false: 127.0.0.1, always the shared local guest.
async function session(c, { viewport = DESKTOP, isolated = true, reuseUser = null } = {}) {
  const base = isolated ? ISOLATED_BASE : BASE
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  const context = await browser.newContext({ viewport, permissions: ['microphone'], acceptDownloads: true })
  let user = null
  if (isolated) {
    user = reuseUser || (await newUser(c.id))
    await context.addInitScript((t) => {
      if (sessionStorage.getItem('verify_seeded')) return
      sessionStorage.setItem('verify_seeded', '1')
      localStorage.setItem('nod_token', t)
    }, user.token)
  }
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror ${e.message}`))
  const ws = wsRecorder(page)
  const fakeMark = (await fakeLog()).length
  let closed = false
  const s = {
    browser, context, page, base, user, ws, consoleErrors,
    goto: (p) => page.goto(base + p, { waitUntil: 'networkidle' }),
    upstream: async () => (await fakeLog()).slice(fakeMark),
    async close() {
      if (closed) return
      closed = true
      writeFileSync(join(c.dir, 'ws-frames.jsonl'), ws.frames.map((f) => JSON.stringify(f)).join('\n') + '\n')
      writeFileSync(join(c.dir, 'upstream.jsonl'), (await this.upstream()).map((e) => JSON.stringify(e)).join('\n') + '\n')
      if (consoleErrors.length) { writeFileSync(join(c.dir, 'console-errors.txt'), consoleErrors.join('\n')); c.note(`${consoleErrors.length} console error(s), first: ${consoleErrors[0].slice(0, 160)}`) }
      await browser.close()
    },
  }
  c.open.push(s)
  return s
}

function wsRecorder(page) {
  const frames = []
  page.on('websocket', (ws) => {
    const url = ws.url()
    const rec = (dir) => (f) => {
      if (typeof f.payload !== 'string') {
        const last = frames[frames.length - 1]
        if (last && last.bin && last.dir === dir) { last.n++; last.bytes += f.payload.length; return }
        frames.push({ t: Date.now(), url, dir, bin: true, n: 1, bytes: f.payload.length })
        return
      }
      frames.push({ t: Date.now(), url, dir, text: f.payload.slice(0, 800) })
    }
    ws.on('framesent', rec('out'))
    ws.on('framereceived', rec('in'))
  })
  return {
    frames,
    typed: (dir, type) => frames.filter((f) => f.dir === dir && f.text && msgType(f.text) === type).map((f) => JSON.parse(f.text)),
    pcmBytes: () => frames.filter((f) => f.bin && f.dir === 'out').reduce((a, f) => a + f.bytes, 0),
  }
}
function msgType(s) { try { return JSON.parse(s).type } catch { return null } }

async function shot(page, c, name) {
  await page.screenshot({ path: join(c.dir, `${name}.png`) })
  writeFileSync(join(c.dir, `${name}.aria.txt`), await page.locator('body').ariaSnapshot().catch((e) => `aria error ${e}`))
}
const seen = (loc, timeout = 15000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false)
const gone = (loc, timeout = 5000) => loc.first().waitFor({ state: 'hidden', timeout }).then(() => true, () => false)
const btn = (page, name) => page.getByRole('button', { name, exact: true })

async function stopListening(page) {
  const stop = btn(page, 'Stop')
  if (await stop.click({ timeout: 1500 }).then(() => true, () => false)) return
  await btn(page, 'Show controls').click()
  await stop.click({ timeout: 5000 })
}

async function fakeScript(lines) {
  await fetch(`${FAKE}/_control/script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines }) })
}
async function fakeLog() { return (await fetch(`${FAKE}/_control/log`)).json() }

const MEETING_LINES = [
  { text: "Let's review the quarterly budget before Friday.", lang: 'en' },
  { text: 'Marketing needs two more designers next month.', lang: 'en' },
  { text: 'Can we ship the beta by the end of October?', lang: 'en' },
]

async function speakMeeting(s, c) {
  await fakeScript(MEETING_LINES)
  await s.goto('/app')
  await btn(s.page, 'Start').click()
  c.ok(await seen(s.page.getByText(MEETING_LINES[0].text), 20000), 'first spoken line appears in Transcript')
  c.ok(await seen(s.page.getByText(MEETING_LINES[2].text), 20000), 'third spoken line appears in Transcript')
}

async function history(token) {
  const r = await api('/api/account/history', { token })
  return r.json?.sessions || r.json?.items || r.json?.history || (Array.isArray(r.json) ? r.json : [])
}

const scenarios = {}
const def = (id, title, run) => { scenarios[id] = { title, run } }

def('api-health', 'Public API: /api/health, /api/config has no secrets, robots, sitemap, 404s', async (c) => {
  const h = await api('/api/health')
  writeFileSync(join(c.dir, 'health.json'), h.text)
  c.ok(h.status === 200 && h.json?.ok === true, `/api/health 200 ok=true (${h.text.slice(0, 80)})`)
  const cfg = await api('/api/config')
  writeFileSync(join(c.dir, 'config.json'), cfg.text)
  c.ok(cfg.status === 200, '/api/config 200')
  c.ok(!/sk_(live|test)_|secret|api_key"\s*:\s*"[^"]/i.test(cfg.text), '/api/config contains no secret-looking values')
  const robots = await api('/robots.txt')
  c.ok(robots.status === 200 && /sitemap/i.test(robots.text), '/robots.txt 200 and names the sitemap')
  const sm = await api('/sitemap.xml')
  c.ok(sm.status === 200 && sm.text.includes('<urlset'), '/sitemap.xml 200 with <urlset>')
  const miss = await api('/api/does-not-exist')
  c.ok(miss.status === 404, `unknown /api path -> 404 (got ${miss.status})`)
  const trav = await api('/..%2fdata%2fnod.db')
  c.ok(trav.status === 404 && !trav.text.includes('SQLite'), `path traversal to nod.db refused (got ${trav.status})`)
})

def('site-pages', 'Marketing site pages render (/, /zh, /privacy, /terms, /consent, /login, /signup) and unknown -> 404', async (c) => {
  const s = await session(c, { isolated: false })
  for (const p of ['/', '/zh', '/privacy', '/terms', '/consent', '/login', '/signup']) {
    const r = await s.page.goto(s.base + p, { waitUntil: 'networkidle' })
    const text = (await s.page.locator('body').innerText()).trim()
    c.ok(r.status() === 200 && text.length > 40, `${p} -> ${r.status()}, ${text.length} chars of text`)
    await shot(s.page, c, `page${p.replace(/\//g, '_') || '_root'}`)
  }
  const r = await s.page.goto(s.base + '/no-such-page', { waitUntil: 'networkidle' })
  c.ok(r.status() === 404, `/no-such-page -> ${r.status()}`)
  await s.close()
})

def('auth-local-guest', 'Localhost boots straight into the workspace as the local guest; non-local Host is refused', async (c) => {
  const r = await api('/api/auth/local-guest', { method: 'POST' })
  c.ok(r.status === 200 && r.json?.token, `POST /api/auth/local-guest from 127.0.0.1 -> ${r.status}`)
  const me = await api('/api/me', { token: r.json?.token })
  c.ok(me.status === 200, `/api/me with guest token -> ${me.status}`)
  const spoof = await api('/api/auth/local-guest', { method: 'POST', headers: { host: 'nodpilot.com' } })
  c.ok(spoof.status === 404, `local-guest with Host: nodpilot.com -> ${spoof.status} (must be 404)`)
  const s = await session(c, { isolated: false })
  await s.goto('/app')
  c.ok(await seen(s.page.getByRole('tablist', { name: 'Workspace mode' })), 'workspace mounts at http://127.0.0.1/app without a login page')
  await shot(s.page, c, 'workspace')
  await s.close()
})

def('auth-password', 'Email + password: register, /api/me, logout, login, wrong password, duplicate email', async (c) => {
  const email = `verify-pw-${Date.now().toString(36)}@example.test`
  const reg = await api('/api/auth/register', { method: 'POST', body: { email, password: 'verify-pass-123', consent: true } })
  c.ok(reg.status === 200 && reg.json?.token, `register -> ${reg.status}`)
  const me = await api('/api/me', { token: reg.json?.token })
  c.ok(me.status === 200 && JSON.stringify(me.json).includes(email), '/api/me returns the new user')
  const dup = await api('/api/auth/register', { method: 'POST', body: { email, password: 'verify-pass-123' } })
  c.ok(dup.status === 409, `duplicate register -> ${dup.status}`)
  const bad = await api('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } })
  c.ok(bad.status === 401 || bad.status === 400, `wrong password -> ${bad.status}`)
  const good = await api('/api/auth/login', { method: 'POST', body: { email, password: 'verify-pass-123' } })
  c.ok(good.status === 200 && good.json?.token, `login -> ${good.status}`)
  const anon = await api('/api/me', { headers: REMOTE })
  c.ok(anon.status === 401, `/api/me without token from a non-local Host -> ${anon.status}`)
  const out = await api('/api/auth/logout', { method: 'POST', token: good.json?.token })
  c.ok(out.status === 200, `logout -> ${out.status}`)
})

def('auth-otp', 'Email code (OTP) signup + verify using the local dev_code, wrong code rejected', async (c) => {
  const email = `verify-otp-${Date.now().toString(36)}@example.test`
  const req = await api('/api/auth/otp/request', { method: 'POST', body: { email, intent: 'signup', consent: true } })
  writeFileSync(join(c.dir, 'otp-request.json'), req.text)
  c.ok(req.status === 200, `otp request -> ${req.status}`)
  const code = req.json?.dev_code
  c.ok(!!code, 'local request returns dev_code (no mail provider configured)')
  const wrong = await api('/api/auth/otp/verify', { method: 'POST', body: { email, code: '000000', intent: 'signup', consent: true } })
  c.ok(wrong.status >= 400, `wrong code -> ${wrong.status}`)
  const ok = await api('/api/auth/otp/verify', { method: 'POST', body: { email, code, intent: 'signup', consent: true } })
  writeFileSync(join(c.dir, 'otp-verify.json'), ok.text)
  c.ok(ok.status === 200 && ok.json?.token, `verify with dev_code -> ${ok.status} ${ok.text.slice(0, 120)}`)
  const log = readFileSync(join(RUN, 'server.log'), 'utf8').split('\n').filter((l) => l.includes('sign-in code email was not sent') || l.includes('otp request'))
  writeFileSync(join(c.dir, 'server-log-otp.txt'), log.join('\n'))
  c.note(`server log: ${log.slice(-2).join(' | ').slice(0, 220)}`)
})

def('auth-clerk', 'Google sign-in via Clerk: bogus token rejected; real sign-in needs Clerk keys', async (c) => {
  const cfg = await api('/api/config')
  const r = await api('/api/auth/clerk', { method: 'POST', body: { token: 'not-a-real-clerk-jwt' } })
  c.ok(r.status >= 400 && r.status !== 500 && !r.json?.token, `bogus Clerk token refused -> ${r.status} ${r.text.slice(0, 100)}`)
  c.note(`clerk publishable key configured locally: ${/pk_/.test(cfg.text)}`)
  c.blocked('CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY for a Clerk dev instance and a Google test account')
})

def('meeting-live', 'Listen > Meeting: Start, mic -> STT -> live transcript, Stop, Save to History', async (c) => {
  const s = await session(c)
  await speakMeeting(s, c)
  await shot(s.page, c, '1-listening')
  c.ok(s.ws.typed('out', 'start_listen').length >= 1, 'client sent start_listen over /ws')
  c.ok(s.ws.pcmBytes() > 32000, `client streamed ${s.ws.pcmBytes()} bytes of PCM over /ws`)
  await stopListening(s.page)
  const dlg = s.page.getByRole('dialog', { name: 'Save to History?' })
  c.ok(await seen(dlg, 8000), 'Stop opens the "Save to History?" dialog')
  await shot(s.page, c, '2-save-dialog')
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  c.ok(await gone(dlg), 'dialog closes after Save')
  await sleep(1500)
  const up = await s.upstream()
  c.ok(up.some((e) => e.kind === 'stt_open'), 'server opened an AssemblyAI stream (fake)')
  c.ok(up.some((e) => e.kind === 'stt_control' && e.message?.type === 'Terminate'), 'server sent Terminate to AssemblyAI on Stop')
  const rows = await history(s.user.token)
  writeFileSync(join(c.dir, 'history.json'), JSON.stringify(rows, null, 2))
  c.ok(rows.length === 1, `GET /api/account/history lists ${rows.length} session(s) for this user`)
  await shot(s.page, c, '3-saved')
  await s.close()
})

def('meeting-notes-ask', 'Listen > Meeting: Summarize writes Notes, Ask answers in Notes (LLM via fake DeepSeek)', async (c) => {
  const s = await session(c)
  await speakMeeting(s, c)
  await btn(s.page, 'Summarize').first().click()
  c.ok(await seen(s.page.getByText('Budget review before Friday.'), 15000), 'Summarize renders notes from the LLM reply')
  await shot(s.page, c, '1-notes')
  const box = s.page.getByRole('textbox', { name: /Ask anything/ })
  await box.fill('What did we decide about the budget?')
  await btn(s.page, 'Ask').click()
  c.ok(await seen(s.page.getByText('Mock answer from the fake DeepSeek provider.'), 15000), 'Ask answer renders in Notes')
  await shot(s.page, c, '2-ask')
  const up = await s.upstream()
  c.ok(up.some((e) => e.kind === 'llm' && /structured notes/i.test(e.user)), 'notes prompt reached the LLM')
  c.ok(up.some((e) => e.kind === 'llm' && e.user.includes('What did we decide about the budget?')), 'Ask question reached the LLM')
  await stopListening(s.page)
  await s.close()
})

def('meeting-pause-resume', 'Listen > Meeting: Pause stops audio upstream, Resume continues the same session', async (c) => {
  const s = await session(c)
  await fakeScript(MEETING_LINES.slice(0, 1))
  await s.goto('/app')
  await btn(s.page, 'Start').click()
  c.ok(await seen(s.page.getByText(MEETING_LINES[0].text), 20000), 'line before Pause appears')
  await btn(s.page, 'Pause').click()
  c.ok(await seen(s.page.getByText('Paused', { exact: true }), 5000), 'status reads Paused')
  await sleep(1500)
  await shot(s.page, c, '1-paused')
  const dupAfterPause = await s.page.locator('.listen-line .listen-orig', { hasText: MEETING_LINES[0].text }).count()
  c.ok(dupAfterPause === 1, `the one spoken line is shown ${dupAfterPause} time(s) after Pause (expected 1)`)
  const before = s.ws.pcmBytes()
  await sleep(3000)
  const during = s.ws.pcmBytes() - before
  c.ok(during < 16000, `no meaningful PCM sent while paused (${during} bytes in 3 s)`)
  await fakeScript(MEETING_LINES.slice(1, 2))
  await btn(s.page, 'Start').click()
  c.ok(await seen(s.page.getByText(MEETING_LINES[1].text), 20000), 'after resuming (rail button reads Start while paused) the next line appears in the same transcript')
  const pre = await s.page.locator('.listen-line .listen-orig', { hasText: MEETING_LINES[0].text }).count()
  c.ok(pre === 1, `pre-pause line shown ${pre} time(s) after resume (expected 1)`)
  await shot(s.page, c, '2-resumed')
  await stopListening(s.page)
  const dlg = s.page.getByRole('dialog', { name: 'Save to History?' })
  if (await seen(dlg, 8000)) await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await sleep(1500)
  const rows = await history(s.user.token)
  writeFileSync(join(c.dir, 'history.json'), JSON.stringify(rows, null, 2))
  const saved = (rows[0]?.items || []).filter((i) => i.kind === 'transcript' && i.text === MEETING_LINES[0].text)
  c.ok(saved.length === 1, `saved History has the pre-pause line ${saved.length} time(s) (expected 1), qids ${saved.map((i) => i.qid).join(',')}`)
  await s.close()
})

def('scene-lecture', 'Listen scene picker: switch to Lecture and get lecture-style notes prompt', async (c) => {
  const s = await session(c)
  await s.goto('/app')
  await btn(s.page, 'Meeting').click()
  await s.page.getByRole('option', { name: /^Lecture/ }).click()
  c.ok(await seen(btn(s.page, 'Lecture'), 5000), 'scene chip now reads Lecture')
  await fakeScript(MEETING_LINES)
  await btn(s.page, 'Start').click()
  c.ok(await seen(s.page.getByText(MEETING_LINES[2].text), 20000), 'transcript works in Lecture')
  await btn(s.page, 'Summarize').first().click()
  await sleep(3000)
  const up = await s.upstream()
  const notes = up.filter((e) => e.kind === 'llm' && /notes/i.test(e.user))
  c.ok(notes.some((e) => /lecture/i.test(e.user)), 'notes prompt names the lecture template')
  await shot(s.page, c, 'lecture')
  await stopListening(s.page)
  await s.close()
})

def('live-qa', 'Listen > Live Q&A: a heard question gets a drafted answer', async (c) => {
  const s = await session(c)
  await s.goto('/app')
  await btn(s.page, 'Meeting').click()
  await s.page.getByRole('option', { name: /^Live Q&A/ }).click()
  c.ok(await seen(btn(s.page, 'Live Q&A'), 5000), 'scene chip now reads Live Q&A')
  await fakeScript([{ text: 'What is the biggest risk in this project and how would you handle it?', lang: 'en' }])
  await btn(s.page, 'Start').click()
  c.ok(await seen(s.page.getByText(/biggest risk in this project/), 20000), 'question transcribed')
  const answered = await seen(s.page.getByText('Mock answer from the fake DeepSeek provider.'), 25000)
  await shot(s.page, c, 'qa')
  const up = await s.upstream()
  writeFileSync(join(c.dir, 'llm-prompts.txt'), up.filter((e) => e.kind === 'llm').map((e) => `${e.stream} ${e.user}`).join('\n---\n'))
  c.ok(answered, 'an answer card with the LLM reply appears')
  c.ok(up.some((e) => e.kind === 'llm' && e.user.startsWith('Fragments in order:')), 'question-completeness judge ran before answering')
  await stopListening(s.page)
  await s.close()
})

def('translate-typed', 'Translate: typed Italian line is translated to Chinese', async (c) => {
  const s = await session(c)
  await s.goto('/app')
  await s.page.getByRole('tab', { name: 'Translate' }).click()
  const box = s.page.getByRole('textbox', { name: /Type to translate/ })
  await box.fill('Dobbiamo finire il lavoro entro domani')
  await box.press('Enter')
  c.ok(await seen(s.page.getByText('我们必须在明天之前完成工作'), 15000), 'Chinese translation appears under the typed line')
  await shot(s.page, c, 'typed')
  const asks = s.ws.typed('out', 'ask')
  c.ok(asks.length >= 1, `client sent ${asks.length} ask frame(s)`)
  await s.close()
})

def('translate-voice', 'Translate: Start, spoken lines get Chinese translations, Stop has no Save dialog', async (c) => {
  const s = await session(c)
  await fakeScript(MEETING_LINES)
  await s.goto('/app')
  await s.page.getByRole('tab', { name: 'Translate' }).click()
  await btn(s.page, 'Start').click()
  c.ok(await seen(s.page.getByText(MEETING_LINES[0].text), 20000), 'spoken line appears')
  c.ok(await seen(s.page.getByText('我们在周五之前审查一下季度预算。'), 20000), 'its Chinese translation appears')
  c.ok(await seen(s.page.getByText('我们能在十月底之前发布测试版吗？'), 20000), 'third line translation appears')
  await shot(s.page, c, '1-live')
  const retries = await s.page.getByRole('button', { name: 'Retry' }).count()
  c.ok(retries === 0, `no line shows Retry (${retries})`)
  await stopListening(s.page)
  await sleep(1500)
  c.ok(await s.page.getByRole('dialog', { name: 'Save to History?' }).count() === 0, 'Translate Stop does not open the Save dialog')
  await shot(s.page, c, '2-stopped')
  await s.close()
})

def('mode-isolation', 'An unsaved Meeting must not reappear inside Translate after reload', async (c) => {
  const s = await session(c)
  await speakMeeting(s, c)
  await stopListening(s.page)
  await seen(s.page.getByRole('dialog', { name: 'Save to History?' }), 8000)
  await s.page.reload({ waitUntil: 'networkidle' })
  await s.page.getByRole('tab', { name: 'Translate' }).click()
  await sleep(2500)
  await shot(s.page, c, 'translate-after-reload')
  const leaked = await s.page.getByText(MEETING_LINES[0].text).count()
  c.ok(leaked === 0, `Translate shows ${leaked} Meeting line(s) after reload (expected 0)`)
  await s.close()
  const s2 = await session(c, { reuseUser: s.user })
  await s2.goto('/app')
  await s2.page.getByRole('tab', { name: 'Translate' }).click()
  await sleep(3000)
  await shot(s2.page, c, 'translate-in-new-browser')
  const leaked2 = await s2.page.getByText(MEETING_LINES[0].text).count()
  c.ok(leaked2 === 0, `new browser, same account: Translate shows ${leaked2} Meeting line(s) (expected 0)`)
  const tr = (await s2.upstream()).filter((e) => e.kind === 'llm' && e.user.startsWith('Translate to'))
  c.ok(tr.length === 0, `Translate sent ${tr.length} translate request(s) for Meeting lines (expected 0)`)
  await s2.close()
})

def('history', 'History: saved session listed, search filters, open restores transcript, delete removes it', async (c) => {
  const s = await session(c)
  await speakMeeting(s, c)
  await stopListening(s.page)
  const dlg = s.page.getByRole('dialog', { name: 'Save to History?' })
  await seen(dlg, 8000)
  await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await sleep(1500)
  await btn(s.page, 'New session').click()
  await sleep(800)
  await btn(s.page, 'History').click()
  const pane = s.page.getByRole('dialog', { name: 'History' })
  c.ok(await seen(pane, 5000), 'History dialog opens')
  const items = pane.getByRole('listitem')
  c.ok(await seen(items, 5000) && (await items.count()) === 1, `History lists ${await items.count()} session(s)`)
  await shot(s.page, c, '1-list')
  await pane.getByRole('searchbox', { name: 'Search' }).fill('designers')
  await sleep(800)
  c.ok((await items.count()) === 1, 'search "designers" keeps the session')
  await pane.getByRole('searchbox', { name: 'Search' }).fill('zebra-no-match')
  await sleep(800)
  c.ok((await items.count()) === 0, 'search "zebra-no-match" hides it')
  await shot(s.page, c, '2-search-miss')
  await pane.getByRole('searchbox', { name: 'Search' }).fill('')
  await sleep(500)
  await items.first().getByRole('button').first().click()
  c.ok(await seen(s.page.getByText(MEETING_LINES[1].text), 8000), 'opening the session restores its transcript')
  await shot(s.page, c, '3-opened')
  const rows = await history(s.user.token)
  const id = rows[0]?.id || rows[0]?.session_id
  const del = await api(`/api/account/history/${id}`, { method: 'DELETE', token: s.user.token })
  c.ok(del.status === 200, `DELETE /api/account/history/<id> -> ${del.status}`)
  c.ok((await history(s.user.token)).length === 0, 'history empty after delete')
  await s.close()
})

def('export-pdf', 'Export PDF from a Meeting downloads a real PDF', async (c) => {
  const s = await session(c)
  await speakMeeting(s, c)
  await stopListening(s.page)
  const dlg = s.page.getByRole('dialog', { name: 'Save to History?' })
  if (await seen(dlg, 8000)) await dlg.getByRole('button', { name: 'Save', exact: true }).click()
  await sleep(1000)
  const dl = s.page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
  await btn(s.page, 'Export PDF').click()
  const d = await dl
  if (!c.ok(d, 'clicking Export PDF starts a download')) { await shot(s.page, c, 'no-download'); await s.close(); return }
  const file = join(c.dir, d.suggestedFilename() || 'export.pdf')
  await d.saveAs(file)
  const head = readFileSync(file).subarray(0, 5).toString()
  c.ok(head === '%PDF-', `downloaded ${d.suggestedFilename()} starts with %PDF-`)
  await s.close()
})

def('attachments', 'Attach a text file with +, the Ask sends its content to the LLM', async (c) => {
  const s = await session(c)
  await s.goto('/app')
  await s.page.getByRole('tab', { name: 'Translate' }).click()
  const file = join(c.dir, 'agenda.txt')
  writeFileSync(file, 'Agenda: VERIFY-ATTACH-TOKEN budget review.\n')
  const chooser = s.page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null)
  await btn(s.page, 'Attach Office, PDF, or image').click()
  const fc = await chooser
  if (!c.ok(fc, 'the + button opens a file chooser')) { await s.close(); return }
  await fc.setFiles(file)
  c.ok(await seen(s.page.getByText('agenda.txt'), 5000), 'attachment chip shows agenda.txt')
  await shot(s.page, c, '1-attached')
  const box = s.page.getByRole('textbox', { name: /Type to translate/ })
  await box.fill('Please translate the agenda')
  await box.press('Enter')
  await sleep(4000)
  const up = await s.upstream()
  c.ok(up.some((e) => e.kind === 'llm' && e.user.includes('VERIFY-ATTACH-TOKEN')), 'LLM request contains the attached file text')
  await shot(s.page, c, '2-sent')
  await s.close()
})

def('account', 'Phone Account sheet: Sign out and Delete account; delete really removes the user', async (c) => {
  const s = await session(c, { viewport: PHONE })
  await s.goto('/app')
  await btn(s.page, 'Account').click()
  c.ok(await seen(s.page.getByText('Sign out'), 5000), 'Account sheet shows Sign out')
  await shot(s.page, c, '1-account')
  await s.page.getByText('Delete account').click()
  c.ok(await seen(s.page.getByText('Delete my Nodpilot account'), 5000), 'Delete account confirmation appears')
  await shot(s.page, c, '2-confirm')
  const confirm = s.page.getByRole('button', { name: /^Delete/ }).last()
  await confirm.click()
  await sleep(2500)
  const me = await api('/api/me', { token: s.user.token, headers: REMOTE })
  c.ok(me.status === 401, `/api/me for the deleted user (non-local Host) -> ${me.status}`)
  c.note(`page after delete: ${s.page.url()}`)
  await shot(s.page, c, '3-after-delete')
  await s.close()
})

def('settings', 'Desktop Settings popover: opacity slider, version, Sign out returns to login', async (c) => {
  const s = await session(c)
  await s.goto('/app')
  await btn(s.page, 'Settings').click()
  c.ok(await seen(s.page.getByRole('slider'), 5000), 'opacity slider visible')
  c.ok(await seen(s.page.getByText('Version'), 5000), 'version row visible')
  await shot(s.page, c, '1-settings')
  await btn(s.page, 'Sign out').click()
  await sleep(2500)
  c.note(`Sign out lands on ${s.page.url()}`)
  c.ok(!(await s.page.evaluate(() => localStorage.getItem('nod_token'))), 'token removed from localStorage')
  await shot(s.page, c, '2-signed-out')
  await s.page.goto(s.base + '/app', { waitUntil: 'networkidle' })
  c.ok(/\/login/.test(s.page.url()), `reopening /app now redirects to ${s.page.url()}`)
  await shot(s.page, c, '3-app-after-signout')
  await s.close()
})

def('tts', 'Text-to-speech (ElevenLabs): status endpoint reports it off; real speech needs a key', async (c) => {
  const st = await api('/api/tts/status')
  writeFileSync(join(c.dir, 'tts-status.json'), st.text)
  c.ok(st.status === 200, `/api/tts/status -> ${st.status} ${st.text.slice(0, 80)}`)
  c.blocked('ELEVENLABS_API_KEY to synthesize audio for Play translation / Auto play')
})

def('billing', 'Plans endpoint works; Stripe checkout needs keys', async (c) => {
  const p = await api('/api/plans')
  c.ok(p.status === 200 && Array.isArray(p.json?.plans), `/api/plans -> ${p.status}, ${p.json?.plans?.length} plans, stripe_enabled=${p.json?.stripe_enabled}`)
  const u = await newUser('billing')
  const co = await api('/api/billing/checkout', { method: 'POST', token: u.token })
  c.ok(co.status === 503, `checkout without Stripe -> ${co.status} (clear 503, not a crash)`)
  c.blocked('STRIPE_SECRET_KEY + STRIPE_PRICE_PRO (test mode) + STRIPE_WEBHOOK_SECRET')
})

def('feedback', 'Feedback form endpoint stores a message', async (c) => {
  const r = await api('/api/feedback', { method: 'POST', body: { email: 'verify@example.test', message: 'verify-nodpilot feedback probe' } })
  c.ok(r.status === 200 && r.json?.ok, `POST /api/feedback -> ${r.status}`)
  const short = await api('/api/feedback', { method: 'POST', body: { message: 'x' } })
  c.ok(short.status === 422, `too-short message -> ${short.status}`)
  c.note('delivery of the copy email needs RESEND_API_KEY or SMTP_*; stored row verified via admin scenario')
})

def('admin', 'Admin console: wrong token refused, right token reaches overview, users, feedback', async (c) => {
  const bad = await api('/api/admin/login', { method: 'POST', body: { token: 'wrong' } })
  c.ok(bad.status === 401, `wrong admin token -> ${bad.status}`)
  const noauth = await api('/api/admin/overview')
  c.ok(noauth.status === 401, `overview without token -> ${noauth.status}`)
  for (const p of ['/api/admin/overview', '/api/admin/users', '/api/admin/feedback', '/api/admin/sessions']) {
    const r = await api(p, { headers: { 'x-admin-token': ADMIN } })
    writeFileSync(join(c.dir, p.split('/').pop() + '.json'), r.text)
    c.ok(r.status === 200, `${p} with token -> ${r.status}`)
  }
  const s = await session(c, { isolated: false })
  await s.goto('/admin')
  await shot(s.page, c, 'admin-page')
  c.ok((await s.page.locator('body').innerText()).length > 20, '/admin page renders')
  await s.close()
})

def('prod-readonly', 'Production nodpilot.com: GET /api/health and GET / only', async (c) => {
  const h = await fetch('https://nodpilot.com/api/health', { signal: AbortSignal.timeout(15000) }).catch((e) => ({ status: 0, text: async () => String(e) }))
  const body = await h.text()
  writeFileSync(join(c.dir, 'prod-health.json'), body)
  c.ok(h.status === 200 && /"ok":\s*true/.test(body), `GET https://nodpilot.com/api/health -> ${h.status} ${body.slice(0, 120)}`)
  const home = await fetch('https://nodpilot.com/', { signal: AbortSignal.timeout(15000) }).catch(() => ({ status: 0, text: async () => '' }))
  const html = await home.text()
  c.ok(home.status === 200 && /Nodpilot/i.test(html), `GET https://nodpilot.com/ -> ${home.status}, ${html.length} bytes`)
})

def('native-apps', 'iOS app, Apple Watch app, Android APK', async (c) => {
  c.blocked('macOS + Xcode (npm run check:ios / cap:ios), a paired iPhone + Watch, or Android SDK + device (npm run cap:android)')
})

async function runScenario(id) {
  const dir = join(RUN, 'scenarios', id)
  mkdirSync(dir, { recursive: true })
  const c = new Check(id, dir)
  const t0 = Date.now()
  try { await scenarios[id].run(c) } catch (e) {
    c.ok(false, `threw: ${String(e.message).split('\n')[0]}`)
    writeFileSync(join(c.dir, 'error.txt'), String(e.stack || e.message))
    for (const s of c.open) await shot(s.page, c, 'on-failure').catch(() => {})
  }
  for (const s of c.open) await s.close().catch(() => {})
  const result = { id, title: scenarios[id].title, status: c.status, ms: Date.now() - t0, steps: c.steps, notes: c.notes, dir }
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
  appendFileSync(join(RUN, 'results.jsonl'), JSON.stringify(result) + '\n')
  const mark = { PASS: 'PASS', FAIL: 'FAIL', 'NOT VERIFIABLE': 'N/V ' }[c.status]
  console.log(`${mark} ${id}  (${result.ms} ms)`)
  for (const s of c.steps) console.log(`     ${s.ok ? 'ok ' : 'XX '} ${s.what}`)
  for (const n of c.notes) console.log(`     note: ${n}`)
  return result
}

async function ariaDump(path, viewportName = 'desktop', clickName) {
  const c = { id: 'aria', dir: RUN, note() {} }
  const s = await session(c, { viewport: viewportName === 'phone' ? PHONE : DESKTOP, isolated: false })
  await s.goto(path)
  if (clickName) await s.page.getByRole(clickName.startsWith('tab:') ? 'tab' : 'button', { name: clickName.replace(/^tab:/, ''), exact: true }).click()
  await sleep(800)
  console.log(await s.page.locator('body').ariaSnapshot())
  if (s.consoleErrors.length) console.log('console errors:', s.consoleErrors)
  await s.browser.close()
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'aria') {
  await ariaDump(rest[0] || '/app', rest[1], rest[2])
} else if (cmd === 'list' || !cmd) {
  for (const [id, s] of Object.entries(scenarios)) console.log(`${id.padEnd(22)} ${s.title}`)
} else {
  const ids = cmd === 'all' ? Object.keys(scenarios).filter((id) => id !== 'prod-readonly') : [cmd, ...rest]
  for (const id of ids) if (!scenarios[id]) throw new Error(`unknown scenario ${id}; try: control-nod drive list`)
  const results = []
  for (const id of ids) results.push(await runScenario(id))
  const tally = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {})
  console.log(`\n${JSON.stringify(tally)}  evidence: ${RUN}/scenarios`)
  process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0
}
