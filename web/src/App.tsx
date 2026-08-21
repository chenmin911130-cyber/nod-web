import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { AttachPayload } from './attach'
import type { AppConfig, AppState, AudioSource, EngineEvent, Lang, PairLang, TranslatePair, ViewMode, WorkspaceMode } from './types'
import TitleBar from './components/TitleBar'
import SideRail from './components/SideRail'
import AnswerPane from './components/AnswerPane'
import MeetingPane from './components/MeetingPane'
import TranslatePane from './components/TranslatePane'
import StatusToast from './components/StatusToast'
import AutoOverlay from './components/AutoOverlay'
import KeySetup from './components/KeySetup'

const PLACEHOLDER = 'Waiting for the next question…'
const STATUS_READY = 'Ready · F2 record / F3 listen / F4 clear'
const TRANSLATE_PREFIX = 'Translate to '
const SUMMARY_PREFIX = 'Summarize the following meeting transcript'

const initial: AppState = {
  run: 'idle',
  status: 'Starting…',
  currentQ: PLACEHOLDER,
  currentQId: '',
  turns: [],
  partial: '',
  busy: false,
  opacity: 83,
  pinned: true,
  micMuted: false,
  systemMuted: false,
  stealth: false,
  view: 'workspace',
  draft: '',
  llm: { provider: 'deepseek', model: '' },
  lang: 'auto',
  source: 'system',
  autoOn: false,
  models: [],
  keys: { hasLlm: true, hasStt: true },
  workspaceMode: 'interview',
  meetingLines: [],
  meetingSummary: '',
  meetingStartedAt: null,
  meetingPausedAt: null,
  meetingElapsedMs: 0,
  meetingEnded: false,
  translatePairs: [],
  translateFrom: 'en',
  translateTo: 'zh',
  bilingual: true,
  translateAskId: '',
  translateBindId: '',
  summaryAskId: '',
}

type Action =
  | { type: 'engine'; ev: EngineEvent }
  | { type: 'opacity'; value: number }
  | { type: 'pinned'; value: boolean }
  | { type: 'mic_muted'; muted: boolean }
  | { type: 'system_muted'; muted: boolean }
  | { type: 'stealth'; on: boolean }
  | { type: 'view'; view: ViewMode }
  | { type: 'draft'; text: string }
  | { type: 'llm'; provider: string; model: string }
  | { type: 'lang'; lang: Lang }
  | { type: 'source'; source: AudioSource }
  | { type: 'config'; cfg: AppConfig }
  | { type: 'clear' }
  | { type: 'workspace'; mode: WorkspaceMode }
  | { type: 'flip_pair' }
  | { type: 'bilingual'; on: boolean }
  | { type: 'mark_action' }
  | { type: 'meeting_clock'; startedAt: number | null; elapsedMs: number }
  | { type: 'meeting_ended' }
  | { type: 'seed_translate'; text: string; id: string }
  | { type: 'bind_translate'; id: string }

function formatClock(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTs(startedAt: number | null): string {
  if (!startedAt) {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function isTranslatePrompt(text: string): boolean {
  return text.startsWith(TRANSLATE_PREFIX) || text.startsWith('[NOD_TRANSLATE]')
}

function isSummaryPrompt(text: string): boolean {
  return text.startsWith(SUMMARY_PREFIX) || text.startsWith('[NOD_SUMMARY]')
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'config': {
      const cfg = action.cfg
      const llm = { provider: cfg.llm?.provider ?? 'deepseek', model: cfg.llm?.model ?? '' }
      const langRaw = cfg.stt?.language
      const lang: Lang = langRaw === 'zh' || langRaw === 'en' ? langRaw : 'auto'
      const srcRaw = cfg.audio?.source ?? 'system'
      const systemMuted = srcRaw === 'mic'
      const source: AudioSource = srcRaw === 'both' || srcRaw === 'mic' ? 'both' : 'system'
      const opacity = Math.min(100, Math.max(10, Math.round(cfg.ui?.opacity ?? 83)))
      return { ...state, llm, lang, source, systemMuted, opacity, models: cfg.models ?? [] }
    }
    case 'engine': {
      const ev = action.ev
      switch (ev.type) {
        case 'ready':
          return { ...state, status: STATUS_READY, run: 'idle' }
        case 'keys_status':
          return { ...state, keys: { hasLlm: ev.has_llm, hasStt: ev.has_stt } }
        case 'state': {
          const run = ev.state as AppState['run']
          let autoOn = state.autoOn
          let view = state.view
          let meetingStartedAt = state.meetingStartedAt
          if (run === 'listen') {
            if (state.workspaceMode === 'interview' && !autoOn && view === 'workspace') view = 'focus'
            autoOn = true
            if (state.workspaceMode === 'meeting' && meetingStartedAt == null) meetingStartedAt = Date.now()
          } else if (run === 'idle') {
            autoOn = false
            if (view !== 'workspace') view = 'workspace'
          }
          const busy = run === 'think'
          return { ...state, run, autoOn, view, busy, meetingStartedAt }
        }
        case 'status':
          return { ...state, status: ev.text }
        case 'partial':
          return { ...state, partial: ev.text }
        case 'question': {
          const qid = ev.id ?? ''
          const text = ev.text ?? ''
          if (isTranslatePrompt(text)) {
            return { ...state, translateAskId: qid, partial: '', busy: true }
          }
          if (isSummaryPrompt(text)) {
            return { ...state, summaryAskId: qid, meetingSummary: '', partial: '', busy: true }
          }
          const ts = formatClock()
          if (state.workspaceMode === 'meeting') {
            const meetingLines = [...state.meetingLines, { id: qid, ts: formatTs(state.meetingStartedAt), text }]
            return { ...state, meetingLines, currentQ: text, currentQId: qid, partial: '' }
          }
          if (state.workspaceMode === 'translate') {
            const translatePairs = [...state.translatePairs, { id: qid, ts, original: text, translation: '' }]
            return { ...state, translatePairs, currentQ: text, currentQId: qid, partial: '' }
          }
          const turns = [...state.turns, { id: qid, q: text, a: '' }]
          return { ...state, turns, currentQ: text, currentQId: qid, partial: '' }
        }
        case 'chunk': {
          let meetingSummary = state.meetingSummary
          let translatePairs = state.translatePairs
          if (ev.id && ev.id === state.summaryAskId) {
            meetingSummary += ev.text
          }
          if (ev.id && ev.id === state.translateAskId) {
            const bindId = state.translateBindId
            const idx = bindId
              ? translatePairs.findIndex((p) => p.id === bindId)
              : translatePairs.length - 1
            if (idx >= 0) {
              translatePairs = translatePairs.slice()
              const row = translatePairs[idx]
              translatePairs[idx] = { ...row, translation: row.translation + ev.text }
            }
          }
          if (state.workspaceMode !== 'interview' || state.turns.length === 0) {
            return { ...state, meetingSummary, translatePairs }
          }
          const turns = state.turns.slice()
          const last = turns[turns.length - 1]
          if (ev.id && last.id !== ev.id && ev.id !== state.translateAskId && ev.id !== state.summaryAskId) {
            return { ...state, meetingSummary, translatePairs }
          }
          if (!ev.id || last.id === ev.id) {
            turns[turns.length - 1] = { ...last, a: last.a + ev.text }
          }
          return { ...state, turns, meetingSummary, translatePairs }
        }
        case 'done':
          return { ...state, busy: false }
        case 'error':
          return { ...state, status: ev.text, busy: false }
        default:
          return state
      }
    }
    case 'opacity':
      return { ...state, opacity: action.value }
    case 'pinned':
      return { ...state, pinned: action.value }
    case 'mic_muted':
      return { ...state, micMuted: action.muted }
    case 'system_muted':
      return { ...state, systemMuted: action.muted }
    case 'stealth':
      return { ...state, stealth: action.on }
    case 'view':
      return { ...state, view: action.view }
    case 'draft':
      return { ...state, draft: action.text }
    case 'llm':
      return { ...state, llm: { provider: action.provider, model: action.model } }
    case 'lang':
      return { ...state, lang: action.lang }
    case 'source':
      return { ...state, source: action.source }
    case 'clear':
      return {
        ...state,
        turns: [],
        currentQ: PLACEHOLDER,
        currentQId: '',
        partial: '',
        status: 'Cleared',
        meetingLines: [],
        meetingSummary: '',
        meetingStartedAt: null,
        meetingElapsedMs: 0,
        meetingEnded: false,
        translatePairs: [],
        translateAskId: '',
        translateBindId: '',
        summaryAskId: '',
      }
    case 'workspace':
      return { ...state, workspaceMode: action.mode, view: 'workspace' }
    case 'flip_pair': {
      const translateFrom = state.translateTo
      const translateTo = state.translateFrom
      return { ...state, translateFrom, translateTo }
    }
    case 'bilingual':
      return { ...state, bilingual: action.on }
    case 'mark_action': {
      if (state.meetingLines.length === 0) return state
      const meetingLines = state.meetingLines.slice()
      const last = meetingLines[meetingLines.length - 1]
      meetingLines[meetingLines.length - 1] = { ...last, marked: true }
      return { ...state, meetingLines, status: 'Marked last line as action' }
    }
    case 'meeting_clock':
      return { ...state, meetingStartedAt: action.startedAt, meetingElapsedMs: action.elapsedMs, meetingEnded: false }
    case 'meeting_ended':
      return { ...state, meetingEnded: true }
    case 'seed_translate': {
      const ts = formatClock()
      const translatePairs = [...state.translatePairs, { id: action.id, ts, original: action.text, translation: '' }]
      return { ...state, translatePairs, currentQ: action.text, translateBindId: action.id }
    }
    case 'bind_translate':
      return { ...state, translateBindId: action.id }
    default:
      return state
  }
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function targetName(lang: PairLang): string {
  return lang === 'zh' ? 'Chinese' : 'English'
}

function engineSource(listenMic: boolean, systemMuted: boolean): AudioSource {
  if (systemMuted) return 'mic'
  return listenMic ? 'both' : 'system'
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial)
  const stateRef = useRef(state)
  stateRef.current = state
  const askedTranslate = useRef<Set<string>>(new Set())
  const tickRef = useRef(0)

  useEffect(() => {
    const api = window.api
    const offEvent = api.onEvent((e) => dispatch({ type: 'engine', ev: e }))
    const offShortcut = api.onShortcut((k) => {
      const mode = stateRef.current.workspaceMode
      if (k === 'f2') api.send({ type: 'manual' })
      else if (k === 'f3') api.send({ type: 'toggle_listen' })
      else if (k === 'f4') {
        askedTranslate.current.clear()
        api.send({ type: 'clear' })
        dispatch({ type: 'clear' })
      }
      else if (k === 'f8' && mode === 'interview') {
        const v = stateRef.current.view
        dispatch({ type: 'view', view: v === 'workspace' ? 'fullscreen' : 'workspace' })
      }
      else if (k === 'f9' && mode === 'interview') {
        const next = !stateRef.current.stealth
        api.setStealth(next)
        dispatch({ type: 'stealth', on: next })
        dispatch({ type: 'engine', ev: { type: 'status', text: next ? 'Stealth on — hidden from screen capture' : 'Stealth off' } })
      }
    })
    api.getConfig().then((cfg) => dispatch({ type: 'config', cfg }))
    return () => {
      offEvent()
      offShortcut()
    }
  }, [])

  const copyLatest = useCallback(() => {
    const s = stateRef.current
    if (s.workspaceMode === 'translate') {
      const pairs = s.translatePairs
      const text = (pairs[pairs.length - 1]?.translation || pairs[pairs.length - 1]?.original || '').trim()
      if (text) {
        window.api.copy(text)
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Copied last translation' } })
      } else {
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Nothing to copy yet.' } })
      }
      return
    }
    if (s.workspaceMode === 'meeting') {
      const lines = s.meetingLines
      const text = (lines[lines.length - 1]?.text ?? '').trim()
      if (text) {
        window.api.copy(text)
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Copied last transcript line' } })
      } else {
        dispatch({ type: 'engine', ev: { type: 'status', text: 'No transcript to copy yet.' } })
      }
      return
    }
    const turns = s.turns
    const text = (turns[turns.length - 1]?.a ?? '').trim()
    if (text) {
      window.api.copy(text)
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Copied latest answer' } })
    } else {
      dispatch({ type: 'engine', ev: { type: 'status', text: 'No completed answer to copy yet.' } })
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (stateRef.current.view !== 'workspace') {
        if (e.ctrlKey && k === 'k') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('ov:show-input'))
        } else if (k === '/') {
          window.dispatchEvent(new CustomEvent('ov:show-input'))
        } else if (k === 'escape') {
          window.dispatchEvent(new CustomEvent('ov:hide-input'))
        } else if (k === 'c') {
          copyLatest()
        }
        return
      }
      if (k === 'a') window.api.send({ type: 'toggle_listen' })
      else if (k === 'c') copyLatest()
      else if (k === 'x') {
        askedTranslate.current.clear()
        window.api.send({ type: 'clear' })
        dispatch({ type: 'clear' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyLatest])

  const handleClear = useCallback(() => {
    askedTranslate.current.clear()
    window.api.send({ type: 'clear' })
    dispatch({ type: 'clear' })
  }, [])
  const handleAsk = useCallback((text: string, files?: AttachPayload[]) => {
    window.api.send({ type: 'ask', text, files })
  }, [])

  const handleOpacity = useCallback((n: number) => {
    window.api.setOpacity(n)
    dispatch({ type: 'opacity', value: n })
  }, [])

  const handlePinned = useCallback((b: boolean) => {
    window.api.setPinned(b)
    dispatch({ type: 'pinned', value: b })
  }, [])

  const handleMicMuted = useCallback((muted: boolean) => {
    window.api.send({ type: 'set_mic_muted', muted })
    dispatch({ type: 'mic_muted', muted })
  }, [])

  const handleStealth = useCallback((on: boolean) => {
    window.api.setStealth(on)
    dispatch({ type: 'stealth', on })
    dispatch({ type: 'engine', ev: { type: 'status', text: on ? 'Stealth on — hidden from screen capture' : 'Stealth off' } })
  }, [])

  const handleModel = useCallback((provider: string, model: string) => {
    window.api.send({ type: 'set_llm', provider, model })
    dispatch({ type: 'llm', provider, model })
  }, [])

  useEffect(() => {
    window.api.setView(state.view)
  }, [state.view])

  const handleLang = useCallback((lang: Lang) => {
    window.api.send({ type: 'set_lang', language: lang === 'auto' ? null : lang })
    dispatch({ type: 'lang', lang })
  }, [])

  const handleSource = useCallback((source: AudioSource) => {
    const s = stateRef.current
    const listenMic = source === 'both'
    const next = engineSource(listenMic, s.systemMuted)
    window.api.send({ type: 'set_source', source: next })
    dispatch({ type: 'source', source: listenMic ? 'both' : 'system' })
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text: s.systemMuted
          ? 'Listen source: microphone only (system audio off)'
          : listenMic
            ? 'Listen source: system + microphone'
            : 'Listen source: system audio',
      },
    })
  }, [])

  const handleSystemMuted = useCallback((muted: boolean) => {
    const s = stateRef.current
    const listenMic = s.source === 'both'
    const next = engineSource(listenMic, muted)
    window.api.send({ type: 'set_source', source: next })
    dispatch({ type: 'system_muted', muted })
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text: muted ? 'System audio off — not capturing speaker output' : 'System audio on',
      },
    })
  }, [])

  const handleMode = useCallback((mode: WorkspaceMode) => {
    const s = stateRef.current
    if (s.stealth && mode !== 'interview') {
      window.api.setStealth(false)
      dispatch({ type: 'stealth', on: false })
    }
    if (s.view !== 'workspace') dispatch({ type: 'view', view: 'workspace' })
    window.api.send({ type: 'set_workspace', mode })
    dispatch({ type: 'workspace', mode })
    if (mode === 'translate' && s.lang !== 'auto') {
      window.api.send({ type: 'set_lang', language: null })
      dispatch({ type: 'lang', lang: 'auto' })
    }
    dispatch({ type: 'engine', ev: { type: 'status', text: `Mode · ${mode[0].toUpperCase()}${mode.slice(1)}` } })
  }, [])

  const handlePrimary = useCallback(() => {
    const s = stateRef.current
    if (s.workspaceMode === 'interview') {
      if (s.run === 'record') return
      window.api.send({ type: 'toggle_listen' })
      return
    }
    if (s.workspaceMode === 'meeting') {
      if (s.run === 'listen' || s.run === 'record') {
        window.api.send({ type: 'toggle_listen' })
        dispatch({ type: 'meeting_ended' })
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Meeting stopped' } })
        return
      }
      if (s.meetingEnded || s.meetingStartedAt == null) {
        dispatch({ type: 'meeting_clock', startedAt: Date.now(), elapsedMs: 0 })
      } else {
        dispatch({ type: 'meeting_clock', startedAt: Date.now() - s.meetingElapsedMs, elapsedMs: s.meetingElapsedMs })
      }
      window.api.send({ type: 'toggle_listen' })
      return
    }
    if (s.run === 'record') return
    window.api.send({ type: 'toggle_listen' })
  }, [])

  const handleRecord = useCallback(() => {
    window.api.send({ type: 'manual' })
  }, [])

  const handlePause = useCallback(() => {
    const s = stateRef.current
    if (s.run === 'listen' || s.run === 'record') {
      window.api.send({ type: 'toggle_listen' })
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Meeting paused' } })
    }
  }, [])

  const handleMark = useCallback(() => {
    dispatch({ type: 'mark_action' })
  }, [])

  const handleFlipLang = useCallback(() => {
    const s = stateRef.current
    dispatch({ type: 'flip_pair' })
    dispatch({
      type: 'engine',
      ev: { type: 'status', text: `Translate ${s.translateTo === 'zh' ? 'CH' : 'EN'} → ${s.translateFrom === 'zh' ? 'CH' : 'EN'}` },
    })
  }, [])

  const askTranslate = useCallback((text: string, pairId?: string) => {
    const s = stateRef.current
    const target = targetName(s.translateTo)
    if (pairId) {
      askedTranslate.current.add(pairId)
      dispatch({ type: 'bind_translate', id: pairId })
    }
    window.api.send({
      type: 'ask',
      mode: 'translate',
      text: `${TRANSLATE_PREFIX}${target}. Output only the translation:\n\n${text}`,
    })
  }, [])

  const handleTranslateTyped = useCallback((text: string, files?: AttachPayload[]) => {
    const id = `typed-${Date.now()}`
    const original = text.trim() || (files?.length ? files.map((f) => f.name).join(', ') : '')
    dispatch({ type: 'seed_translate', text: original, id })
    askedTranslate.current.add(id)
    const s = stateRef.current
    const target = targetName(s.translateTo)
    window.api.send({
      type: 'ask',
      mode: 'translate',
      text: `${TRANSLATE_PREFIX}${target}. Output only the translation:\n\n${text.trim() || 'Translate the attached files.'}`,
      files,
    })
  }, [])

  // Auto-translate completed captions while in Translate mode only
  useEffect(() => {
    if (state.workspaceMode !== 'translate') return
    if (state.busy) return
    const next = state.translatePairs.find((p) => !p.translation && !askedTranslate.current.has(p.id))
    if (!next) return
    askTranslate(next.original, next.id)
  }, [state.translatePairs, state.workspaceMode, state.busy, askTranslate])

  const handleGenerateSummary = useCallback((note?: string, files?: AttachPayload[]) => {
    const s = stateRef.current
    if (note || files?.length) {
      window.api.send({ type: 'ask', text: note || 'Please review the attached files.', files })
      return
    }
    const body = s.meetingLines.map((ln) => `[${ln.ts}${ln.marked ? ' ACTION' : ''}] ${ln.text}`).join('\n')
    if (!body.trim()) {
      dispatch({ type: 'engine', ev: { type: 'status', text: 'No transcript to summarize yet.' } })
      return
    }
    window.api.send({
      type: 'ask',
      text: `${SUMMARY_PREFIX} as concise bullet points. Only the bullets:\n\n${body}`,
    })
  }, [])

  const copyPair = useCallback((pair: TranslatePair) => {
    const text = (pair.translation || pair.original).trim()
    if (!text) {
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Nothing to copy yet.' } })
      return
    }
    window.api.copy(text)
    dispatch({ type: 'engine', ev: { type: 'status', text: pair.translation ? 'Copied translation' : 'Copied original' } })
  }, [])

  const handleExportPdf = useCallback(async () => {
    const s = stateRef.current
    if (s.workspaceMode === 'translate') {
      const pairs = s.translatePairs
      const from = s.translateFrom === 'zh' ? 'CH' : 'EN'
      const to = s.translateTo === 'zh' ? 'CH' : 'EN'
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Nod Translate</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; color: #102033; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #5b6b80; font-size: 12px; margin-bottom: 22px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; letter-spacing: 1.2px; text-transform: uppercase; color: #0e7490; padding: 0 12px 8px 0; }
  td { vertical-align: top; padding: 8px 12px 8px 0; line-height: 1.5; border-top: 1px solid #e6eef6; }
  .ts { color: #0e7490; font-weight: 700; width: 48px; }
</style></head><body>
<h1>Nod captions</h1>
<div class="sub">${from} → ${to} · Exported ${new Date().toLocaleString()}</div>
<table>
  <tr><th></th><th>${from}</th><th>${to}</th></tr>
  ${pairs.length
    ? pairs.map((p) => `<tr><td class="ts">${escapeHtml(p.ts)}</td><td>${escapeHtml(p.original)}</td><td>${escapeHtml(p.translation)}</td></tr>`).join('')
    : '<tr><td colspan="3">No captions yet.</td></tr>'}
</table>
</body></html>`
      try {
        const dest = await window.api.exportPdf({ title: 'Nod Translate', html })
        if (!dest) {
          dispatch({ type: 'engine', ev: { type: 'status', text: 'Export cancelled' } })
          return
        }
        dispatch({ type: 'engine', ev: { type: 'status', text: `Exported PDF · ${dest}` } })
      } catch (err) {
        dispatch({ type: 'engine', ev: { type: 'status', text: `PDF export failed: ${err instanceof Error ? err.message : String(err)}` } })
      }
      return
    }
    const lines = s.meetingLines
    const actions = lines.filter((ln) => ln.marked)
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Nod Meeting</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; color: #102033; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #5b6b80; font-size: 12px; margin-bottom: 22px; }
  h2 { font-size: 13px; letter-spacing: 1.4px; text-transform: uppercase; color: #0e7490; margin: 22px 0 10px; }
  .ln { margin: 0 0 8px; line-height: 1.5; }
  .ts { color: #0e7490; font-weight: 700; margin-right: 8px; }
  .flag { color: #b45309; font-weight: 700; }
  .sum { white-space: pre-wrap; line-height: 1.55; }
</style></head><body>
<h1>Nod meeting notes</h1>
<div class="sub">Exported ${new Date().toLocaleString()}</div>
<h2>Live transcript</h2>
${lines.length ? lines.map((ln) => `<div class="ln"><span class="ts">${escapeHtml(ln.ts)}</span>${ln.marked ? '<span class="flag">Action · </span>' : ''}${escapeHtml(ln.text)}</div>`).join('') : '<p>No transcript lines.</p>'}
${actions.length ? `<h2>Marked actions</h2>${actions.map((ln) => `<div class="ln"><span class="ts">${escapeHtml(ln.ts)}</span>${escapeHtml(ln.text)}</div>`).join('')}` : ''}
<h2>Summary</h2>
<div class="sum">${s.meetingSummary ? escapeHtml(s.meetingSummary) : 'No summary generated.'}</div>
</body></html>`
    try {
      const dest = await window.api.exportPdf({ title: 'Nod Meeting', html })
      if (!dest) {
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Export cancelled' } })
        return
      }
      dispatch({ type: 'engine', ev: { type: 'status', text: `Exported PDF · ${dest}` } })
    } catch (err) {
      dispatch({ type: 'engine', ev: { type: 'status', text: `PDF export failed: ${err instanceof Error ? err.message : String(err)}` } })
    }
  }, [])

  // Meeting elapsed clock
  useEffect(() => {
    if (state.workspaceMode !== 'meeting' || state.meetingStartedAt == null) return
    if (state.run !== 'listen' && state.run !== 'record') return
    const id = window.setInterval(() => {
      tickRef.current += 1
      const started = stateRef.current.meetingStartedAt
      if (started) dispatch({ type: 'meeting_clock', startedAt: started, elapsedMs: Date.now() - started })
    }, 1000)
    return () => window.clearInterval(id)
  }, [state.workspaceMode, state.meetingStartedAt, state.run])

  if (!state.keys.hasLlm || !state.keys.hasStt) {
    return <KeySetup hasLlm={state.keys.hasLlm} hasStt={state.keys.hasStt} />
  }

  if (state.view !== 'workspace' && state.workspaceMode === 'interview') {
    const fullscreen = state.view === 'fullscreen'
    return (
      <div className={`app overlay-app${fullscreen ? ' fullscreen' : ''}`}>
        <AutoOverlay
          run={state.run}
          currentQ={state.currentQ}
          partial={state.partial}
          turns={state.turns}
          busy={state.busy}
          autoOn={state.autoOn}
          fullscreen={fullscreen}
          draft={state.draft}
          pinned={state.pinned}
          stealth={state.stealth}
          micMuted={state.micMuted}
          onDraft={(text) => dispatch({ type: 'draft', text })}
          onAsk={handleAsk}
          onCopy={copyLatest}
          onExpand={() => dispatch({ type: 'view', view: 'workspace' })}
          onStop={() => {
            window.api.send({ type: 'toggle_listen' })
            if (state.autoOn) dispatch({ type: 'view', view: 'workspace' })
          }}
          onViewToggle={() =>
            dispatch({ type: 'view', view: fullscreen ? 'workspace' : 'fullscreen' })
          }
          onPinned={handlePinned}
          onStealth={handleStealth}
          onMicMuted={handleMicMuted}
        />
      </div>
    )
  }

  const listening = state.run === 'listen' || state.run === 'record'
  const elapsedLabel = formatElapsed(state.meetingElapsedMs)

  return (
    <div className="app">
      <TitleBar
        mode={state.workspaceMode}
        models={state.models}
        llm={state.llm}
        lang={state.lang}
        source={state.source}
        opacity={state.opacity}
        pinned={state.pinned}
        systemMuted={state.systemMuted}
        stealth={state.stealth}
        onMode={handleMode}
        onModel={handleModel}
        onLang={handleLang}
        onSource={handleSource}
        onOpacity={handleOpacity}
        onPinned={handlePinned}
        onSystemMuted={handleSystemMuted}
        onStealth={handleStealth}
        onFullScreen={() => dispatch({ type: 'view', view: 'fullscreen' })}
      />
      <div className="workspace">
        <SideRail
          mode={state.workspaceMode}
          run={state.run}
          autoOn={state.autoOn}
          bilingual={state.bilingual}
          translateFrom={state.translateFrom}
          translateTo={state.translateTo}
          onPrimary={handlePrimary}
          onRecord={handleRecord}
          onCopy={copyLatest}
          onClear={handleClear}
          onPause={handlePause}
          onMark={handleMark}
          onExport={() => { void handleExportPdf() }}
          onFlipLang={handleFlipLang}
          onBilingual={() => dispatch({ type: 'bilingual', on: !state.bilingual })}
          meetingPaused={
            state.workspaceMode === 'meeting'
            && !listening
            && state.meetingStartedAt != null
            && !state.meetingEnded
          }
        />
        {state.workspaceMode === 'meeting' ? (
          <MeetingPane
            lines={state.meetingLines}
            partial={state.partial}
            summary={state.meetingSummary}
            busy={state.busy}
            elapsedLabel={elapsedLabel}
            listening={listening}
            onGenerate={handleGenerateSummary}
          />
        ) : state.workspaceMode === 'translate' ? (
          <TranslatePane
            pairs={state.translatePairs}
            partial={state.partial}
            busy={state.busy}
            bilingual={state.bilingual}
            from={state.translateFrom}
            to={state.translateTo}
            onTranslate={handleTranslateTyped}
            onCopyPair={copyPair}
          />
        ) : (
          <AnswerPane
            currentQ={state.currentQ}
            partial={state.partial}
            turns={state.turns}
            busy={state.busy}
            onAsk={handleAsk}
          />
        )}
      </div>
      <StatusToast text={state.status} />
    </div>
  )
}
