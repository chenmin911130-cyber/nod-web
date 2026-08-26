import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AttachPayload } from './attach'
import type { AppConfig, AppState, AudioSource, EngineEvent, Lang, MeetingLine, PairLang, TranslatePair, ViewMode, WorkspaceMode } from './types'
import { TRANSLATE_LANGS } from './types'
import { isWeb } from './platform'
import TitleBar from './components/TitleBar'
import SideRail from './components/SideRail'
import AnswerPane from './components/AnswerPane'
import ListenPane from './components/ListenPane'
import TranslatePane from './components/TranslatePane'
import StatusToast from './components/StatusToast'
import AutoOverlay from './components/AutoOverlay'
import KeySetup from './components/KeySetup'
import { api as authApi, fetchMe } from './auth'
import {
  askContext,
  askPrompt,
  catchupPrompt,
  isAskPrompt,
  isCatchPrompt,
  isNotesPrompt,
  lastTwoMinutes,
  notesPrompt,
  exportNoteSections,
  parseNotes,
  type ListenScene,
} from './listen'

const PLACEHOLDER = 'Waiting for the next question…'
const STATUS_READY = 'Ready · F2 record / F3 listen / F4 clear'
const TRANSLATE_PREFIX = 'Translate to '
const SUMMARY_PREFIX = 'Summarize the following meeting transcript'
const TRANSLATE_PAIR_KEY = 'nod_translate_pair'

function isPairLang(value: unknown): value is PairLang {
  return TRANSLATE_LANGS.some((l) => l.id === value)
}

function isLang(value: unknown): value is Lang {
  return value === 'auto' || isPairLang(value)
}

function readStoredPair(): { from: Lang; to: PairLang } | null {
  try {
    const raw = localStorage.getItem(TRANSLATE_PAIR_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { from?: unknown; to?: unknown }
    if (!isLang(parsed.from) || !isPairLang(parsed.to)) return null
    return { from: parsed.from, to: parsed.to }
  } catch {
    return null
  }
}

function persistTranslatePair(from: Lang, to: PairLang) {
  try {
    localStorage.setItem(TRANSLATE_PAIR_KEY, JSON.stringify({ from, to }))
  } catch {
    /* private mode / quota */
  }
}

function swapTranslatePair(from: Lang, to: PairLang, heard: PairLang | null): { from: Lang; to: PairLang } {
  if (from === 'auto') {
    const nextFrom = to
    const nextTo = heard && heard !== to ? heard : to === 'zh' ? 'en' : 'zh'
    return { from: nextFrom, to: nextTo }
  }
  if (from === to) return { from, to: from === 'zh' ? 'en' : 'zh' }
  return { from: to, to: from }
}

const storedPair = readStoredPair()

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
  workspaceMode: 'meeting',
  meetingLines: [],
  meetingSummary: '',
  meetingStartedAt: null,
  meetingPausedAt: null,
  meetingElapsedMs: 0,
  meetingEnded: false,
  translatePairs: [],
  translateFrom: storedPair?.from ?? 'auto',
  translateTo: storedPair?.to ?? 'zh',
  heardLang: null,
  bilingual: true,
  translateAskId: '',
  translateBindId: '',
  summaryAskId: '',
  listenScene: 'meeting' as ListenScene,
  translateOn: false,
  catchNotes: [],
  catchPendingTitle: '',
  catchAskId: '',
  notesRaw: '',
  notesAskId: '',
  quota: null as { stt_seconds: number; stt_limit: number; llm_tokens: number; llm_limit: number; ok: boolean; quota_disabled?: boolean } | null,
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
  | { type: 'translate_from'; lang: Lang }
  | { type: 'translate_to'; lang: PairLang }
  | { type: 'bilingual'; on: boolean }
  | { type: 'mark_action' }
  | { type: 'meeting_clock'; startedAt: number | null; elapsedMs: number }
  | { type: 'meeting_ended' }
  | { type: 'seed_translate'; text: string; id: string }
  | { type: 'bind_translate'; id: string }
  | { type: 'release_translate' }
  | { type: 'fill_translate'; id: string; translation: string; passthrough?: boolean }
  | { type: 'retry_translate'; id: string }
  | { type: 'fail_translate'; id: string }
  | { type: 'ask_start' }
  | { type: 'expect_meeting_ask' }
  | { type: 'listen_scene'; scene: ListenScene }
  | { type: 'translate_on'; on: boolean }
  | { type: 'listen_new' }
  | { type: 'expect_catch'; title?: string; kind?: 'catch' | 'ask'; question?: string }
  | { type: 'expect_notes' }

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
  const t = (text || '').trim()
  return (
    t.startsWith(TRANSLATE_PREFIX) ||
    t.startsWith('[NOD_TRANSLATE') ||
    t.includes('[NOD_TRANSLATE') ||
    t.includes('Output only the translation')
  )
}

function translateBindFromPrompt(text: string): string {
  const m = /^\[NOD_TRANSLATE:([^\]]+)\]/.exec(text)
  return m?.[1] ?? ''
}

function applyLineTranslation(lines: MeetingLine[], bindId: string, chunk: string): MeetingLine[] {
  if (!lines.length || !chunk) return lines
  let idx = bindId ? lines.findIndex((line) => line.id === bindId) : -1
  if (idx < 0) idx = lines.findIndex((line) => !line.translation)
  if (idx < 0) return lines
  const next = lines.slice()
  next[idx] = { ...next[idx], translation: (next[idx].translation || '') + chunk }
  return next
}

function applyTranslateChunk(pairs: TranslatePair[], bindId: string, chunk: string): TranslatePair[] {
  if (!pairs.length || !chunk) return pairs
  let idx = bindId ? pairs.findIndex((p) => p.id === bindId) : -1
  if (idx >= 0 && isTranslatePrompt(pairs[idx].original)) idx = -1
  if (idx < 0) idx = pairs.findIndex((p) => !p.translation && !p.failed && !isTranslatePrompt(p.original))
  if (idx < 0) return pairs
  const next = pairs.slice()
  const row = next[idx]
  next[idx] = { ...row, translation: row.translation + chunk, failed: false }
  return next
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
      const lang: Lang = TRANSLATE_LANGS.some((l) => l.id === langRaw) ? (langRaw as Lang) : 'auto'
      const srcRaw = cfg.audio?.source ?? 'system'
      const systemMuted = srcRaw === 'mic'
      const source: AudioSource = srcRaw === 'both' || srcRaw === 'mic' ? 'both' : 'system'
      const opacity = Math.min(100, Math.max(10, Math.round(cfg.ui?.opacity ?? 83)))
      const stored = readStoredPair()
      const fromRaw = stored?.from ?? cfg.ui?.translate_from
      const translateFrom: Lang = isLang(fromRaw) ? fromRaw : state.translateFrom
      const toRaw = stored?.to ?? cfg.ui?.translate_to
      const translateTo: PairLang = isPairLang(toRaw) ? toRaw : state.translateTo
      return { ...state, llm, lang, source, systemMuted, opacity, models: cfg.models ?? [], translateFrom, translateTo }
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
            if (!isWeb && state.workspaceMode === 'interview' && !autoOn && view === 'workspace') view = 'focus'
            autoOn = true
            if (state.workspaceMode === 'meeting' && meetingStartedAt == null) meetingStartedAt = Date.now()
          } else if (run === 'idle') {
            autoOn = false
            if (view !== 'workspace') view = 'workspace'
          }
          const generating = Boolean(state.translateAskId || state.summaryAskId)
          const busy = run === 'think' || (generating && run !== 'idle')
          return { ...state, run, autoOn, view, busy, meetingStartedAt }
        }
        case 'status':
          return { ...state, status: ev.text }
        case 'partial': {
          const text = ev.text ?? ''
          if (state.workspaceMode === 'translate' && state.translateFrom !== 'auto') {
            const heard = parseHeardLang(ev.language, text)
            if (text && !matchesLockedFrom(text, state.translateFrom, heard)) {
              return { ...state, partial: '' }
            }
          }
          return { ...state, partial: hasSpeechContent(text) ? text : '' }
        }
        case 'question': {
          const qid = ev.id ?? ''
          const text = ev.text ?? ''
          if (isTranslatePrompt(text)) {
            const tagged = translateBindFromPrompt(text)
            return {
              ...state,
              translateAskId: qid,
              translateBindId: tagged || state.translateBindId,
              partial: '',
              busy: true,
            }
          }
          if (isSummaryPrompt(text)) {
            return { ...state, summaryAskId: qid, meetingSummary: '', partial: '', busy: true }
          }
          if (isCatchPrompt(text) || isAskPrompt(text) || state.catchAskId === '__pending__') {
            const pending = state.catchNotes.find((note) => note.id === '__pending__')
            return {
              ...state,
              catchAskId: qid,
              catchNotes: pending
                ? state.catchNotes.map((note) => (note.id === '__pending__' ? { ...note, id: qid } : note))
                : [
                    ...state.catchNotes,
                    {
                      id: qid,
                      kind: isAskPrompt(text) ? 'ask' : 'catch',
                      title: state.catchPendingTitle || (isAskPrompt(text) ? 'Ask' : 'Catch up · last 2 min'),
                      question: '',
                      text: '',
                    },
                  ],
              catchPendingTitle: '',
              partial: '',
              busy: true,
            }
          }
          if (isNotesPrompt(text) || state.notesAskId === '__pending__') {
            return { ...state, notesAskId: qid, notesRaw: '', partial: '', busy: true }
          }
          const ts = formatClock()
          const heard = parseHeardLang(ev.language, text)
          if (state.workspaceMode === 'meeting') {
            if (state.summaryAskId === '__pending__') {
              return {
                ...state,
                summaryAskId: qid,
                meetingSummary: '',
                currentQ: text,
                currentQId: qid,
                partial: '',
                busy: true,
                heardLang: heard ?? state.heardLang,
              }
            }
            const meetingLines = [...state.meetingLines, {
              id: qid,
              ts: formatTs(state.meetingStartedAt),
              text,
              at: Date.now(),
            }]
            return { ...state, meetingLines, currentQ: text, currentQId: qid, partial: '', heardLang: heard ?? state.heardLang }
          }
          if (state.workspaceMode === 'translate') {
            if (isTranslatePrompt(text)) {
              const tagged = translateBindFromPrompt(text)
              return {
                ...state,
                translateAskId: qid,
                translateBindId: tagged || state.translateBindId,
                partial: '',
                busy: true,
              }
            }
            const last = state.translatePairs[state.translatePairs.length - 1]
            if (!hasSpeechContent(text)) {
              return { ...state, partial: '' }
            }
            if (state.translateFrom !== 'auto' && !matchesLockedFrom(text, state.translateFrom, heard)) {
              return { ...state, partial: '' }
            }
            if (last && normOriginal(last.original) === normOriginal(text)) {
              return { ...state, currentQ: text, partial: '', heardLang: heard ?? state.heardLang }
            }
            const translatePairs = [...state.translatePairs, {
              id: qid,
              ts,
              original: text,
              translation: '',
              to: state.translateTo,
              from: state.translateFrom !== 'auto' ? state.translateFrom : (heard ?? undefined),
            }]
            return { ...state, translatePairs, currentQ: text, currentQId: qid, partial: '', heardLang: heard ?? state.heardLang }
          }
          const turns = [...state.turns, { id: qid, q: text, a: '' }]
          return { ...state, turns, currentQ: text, currentQId: qid, partial: '', busy: true, heardLang: heard ?? state.heardLang }
        }
        case 'chunk': {
          let meetingSummary = state.meetingSummary
          let translatePairs = state.translatePairs
          let translateAskId = state.translateAskId
          let catchNotes = state.catchNotes
          let catchAskId = state.catchAskId
          let notesRaw = state.notesRaw
          let notesAskId = state.notesAskId
          let meetingLines = state.meetingLines
          if (ev.id && ev.id === state.summaryAskId) {
            meetingSummary += ev.text
          }
          if (state.catchAskId === '__pending__' || (ev.id && ev.id === state.catchAskId)) {
            const nextId = ev.id || state.catchAskId
            const hasPending = catchNotes.some((note) => note.id === '__pending__')
            if (hasPending) {
              catchNotes = catchNotes.map((note) =>
                note.id === '__pending__' ? { ...note, id: nextId, text: note.text + (ev.text ?? '') } : note,
              )
            } else if (ev.id && catchNotes.some((note) => note.id === ev.id)) {
              catchNotes = catchNotes.map((note) =>
                note.id === ev.id ? { ...note, text: note.text + (ev.text ?? '') } : note,
              )
            } else {
              catchNotes = [
                ...catchNotes,
                {
                  id: nextId,
                  kind: 'ask',
                  title: state.catchPendingTitle || 'Ask',
                  text: ev.text ?? '',
                },
              ]
            }
            catchAskId = nextId
          }
          if (notesAskId === '__pending__' || (ev.id && ev.id === notesAskId)) {
            notesRaw += ev.text ?? ''
            notesAskId = ev.id || notesAskId
          }
          if (state.translateBindId && ev.id) {
            translateAskId = ev.id
          }
          const translateChunk =
            Boolean(state.translateBindId) ||
            (Boolean(translateAskId) && ev.id === translateAskId)
          if (translateChunk && state.translateOn && meetingLines.length) {
            meetingLines = applyLineTranslation(meetingLines, state.translateBindId, ev.text ?? '')
          } else if (translateChunk && state.translatePairs.length) {
            translatePairs = applyTranslateChunk(translatePairs, state.translateBindId, ev.text ?? '')
          }
          if (state.workspaceMode !== 'interview' || state.turns.length === 0) {
            return { ...state, meetingSummary, translatePairs, translateAskId, catchNotes, catchAskId, notesRaw, notesAskId, meetingLines }
          }
          const turns = state.turns.slice()
          const last = turns[turns.length - 1]
          if (
            ev.id
            && last.id !== ev.id
            && ev.id !== translateAskId
            && ev.id !== state.summaryAskId
            && ev.id !== catchAskId
            && ev.id !== notesAskId
          ) {
            return { ...state, meetingSummary, translatePairs, translateAskId, catchNotes, catchAskId, notesRaw, notesAskId, meetingLines }
          }
          if (!ev.id || last.id === ev.id) {
            turns[turns.length - 1] = { ...last, a: last.a + ev.text }
          }
          return { ...state, turns, meetingSummary, translatePairs, translateAskId, catchNotes, catchAskId, notesRaw, notesAskId, meetingLines }
        }
        case 'done':
          return { ...state, busy: false, translateAskId: '', summaryAskId: '', catchAskId: '', notesAskId: '' }
        case 'error':
          return { ...state, status: ev.text, busy: false }
        case 'auth_required':
          if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
            window.location.replace('/login?next=/app')
          }
          return state
        case 'quota':
          return {
            ...state,
            quota: {
              ok: ev.ok,
              stt_seconds: ev.stt_seconds,
              stt_limit: ev.stt_limit,
              llm_tokens: ev.llm_tokens,
              llm_limit: ev.llm_limit,
              quota_disabled: ev.quota_disabled,
            },
          }
        case 'quota_exceeded':
          return { ...state, busy: false, status: 'Usage limit reached — open Account' }
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
        catchNotes: [],
        catchPendingTitle: '',
        catchAskId: '',
        notesRaw: '',
        notesAskId: '',
      }
    case 'workspace':
      return { ...state, workspaceMode: action.mode, view: 'workspace' }
    case 'listen_scene':
      return { ...state, listenScene: action.scene }
    case 'translate_on':
      return { ...state, translateOn: action.on }
    case 'listen_new':
      return {
        ...state,
        meetingLines: [],
        meetingSummary: '',
        catchNotes: [],
        catchPendingTitle: '',
        notesRaw: '',
        catchAskId: '',
        notesAskId: '',
        meetingEnded: false,
        meetingStartedAt: Date.now(),
        meetingElapsedMs: 0,
        translateAskId: '',
        translateBindId: '',
      }
    case 'expect_catch': {
      const kind = action.kind || 'catch'
      const title = action.title || (kind === 'ask' ? 'Ask' : 'Catch up · last 2 min')
      return {
        ...state,
        catchAskId: '__pending__',
        catchPendingTitle: title,
        catchNotes: [
          ...state.catchNotes.filter((note) => note.id !== '__pending__'),
          {
            id: '__pending__',
            kind,
            title,
            question: action.question || '',
            text: '',
          },
        ],
        busy: true,
        status: kind === 'ask' ? 'Answering…' : 'Catching up…',
        translateBindId: '',
        translateAskId: '',
      }
    }
    case 'expect_notes':
      return { ...state, notesAskId: '__pending__', notesRaw: '', busy: true, status: 'Writing notes…', translateBindId: '', translateAskId: '' }
    case 'translate_from':
      return { ...state, translateFrom: action.lang }
    case 'translate_to':
      return { ...state, translateTo: action.lang }
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
      const translatePairs = [...state.translatePairs, { id: action.id, ts, original: action.text, translation: '', to: state.translateTo }]
      return { ...state, translatePairs, currentQ: action.text, translateBindId: action.id }
    }
    case 'bind_translate':
      return { ...state, translateBindId: action.id }
    case 'release_translate':
      return { ...state, translateBindId: '', busy: false }
    case 'fill_translate': {
      const translatePairs = state.translatePairs.map((p) =>
        p.id === action.id
          ? { ...p, translation: action.translation, to: state.translateTo, failed: false, passthrough: Boolean(action.passthrough) }
          : p,
      )
      return { ...state, translatePairs, translateBindId: '', busy: false }
    }
    case 'retry_translate': {
      const translatePairs = state.translatePairs.map((p) =>
        p.id === action.id ? { ...p, translation: '', to: state.translateTo, failed: false, passthrough: false } : p,
      )
      return { ...state, translatePairs, translateBindId: action.id }
    }
    case 'ask_start':
      return { ...state, busy: true, status: 'Asking…' }
    case 'expect_meeting_ask':
      return { ...state, summaryAskId: '__pending__', busy: true, status: 'Asking…' }
    case 'fail_translate': {
      const translatePairs = state.translatePairs.map((p) =>
        p.id === action.id ? { ...p, failed: true } : p,
      )
      return { ...state, translatePairs, translateBindId: state.translateBindId === action.id ? '' : state.translateBindId }
    }
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

function targetName(lang: PairLang): string {
  return TRANSLATE_LANGS.find((l) => l.id === lang)?.name ?? lang
}

function normOriginal(text: string): string {
  return (text || '').trim().replace(/\s+/g, ' ')
}

function hasSpeechContent(text: string): boolean {
  return /[A-Za-z0-9\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]/u.test(normOriginal(text))
}

const NOT_ENGLISH_MARKS = /[¿¡ñßœæàâçèéêëîïôùûÿáéíóúüäöüßãõàèìòù]/iu
const NOT_ENGLISH_WORDS =
  /\b(?:hola|gracias|buenos|bonjour|bonsoir|merci|salut|pourquoi|êtes|ça|wie geht|nicht|danke|bitte|guten|você|não|olá|obrigado|perché|ciao|grazie|più|cómo|estás|usted|quién|dónde|también|comment ça|comment ca|como estas|qué tal|que tal)\b/iu

function looksLikeTarget(text: string, to: PairLang): boolean {
  const chars = Array.from(normOriginal(text)).filter((c) => !/\s/u.test(c))
  if (chars.length < 2) return false
  const han = chars.filter((c) => /\p{Script=Han}/u.test(c)).length
  const kana = chars.filter((c) => /[\u3040-\u30FF]/.test(c)).length
  const hangul = chars.filter((c) => /\p{Script=Hangul}/u.test(c)).length
  const latin = chars.filter((c) => /[A-Za-zÀ-ÿ]/.test(c)).length
  const n = chars.length
  if (to === 'zh') return han / n >= 0.5 && kana === 0 && hangul === 0
  if (to === 'ja') return kana / n >= 0.12 || ((han + kana) / n >= 0.5 && kana > 0)
  if (to === 'en') {
    const raw = normOriginal(text)
    return latin / n >= 0.7 && han + kana + hangul === 0 && !NOT_ENGLISH_MARKS.test(raw) && !NOT_ENGLISH_WORDS.test(raw)
  }
  return false
}

function matchesLockedFrom(text: string, locked: PairLang, heard: PairLang | null): boolean {
  if (heard && heard !== locked) return false
  if (locked === 'en' || locked === 'zh' || locked === 'ja') return looksLikeTarget(text, locked)
  if (/[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]/u.test(text)) return false
  const t = normOriginal(text)
  if (/[\u3040-\u30FF]/.test(t)) return locked === 'ja'
  if (/\p{Script=Han}/u.test(t)) return locked === 'zh'
  if (/[¿¡ñ]|cómo|está|hola\b/i.test(t)) return locked === 'es'
  if (/[çœæ]|pourquoi|bonjour|\bça\b/i.test(t)) return locked === 'fr'
  if (/[äöüß]|nicht\b|wie geht/i.test(t)) return locked === 'de'
  if (/perché|ciao\b|grazie|più/i.test(t)) return locked === 'it'
  if (/[ãõ]|você|não|olá/i.test(t)) return locked === 'pt'
  return true
}

function parseHeardLang(raw: string | undefined, text: string): PairLang | null {
  if (raw && TRANSLATE_LANGS.some((l) => l.id === raw)) return raw as PairLang
  const t = normOriginal(text)
  if (!t) return null
  if (/[\u3040-\u30FF]/.test(t)) return 'ja'
  if (/\p{Script=Han}/u.test(t)) return 'zh'
  if (/[¿¡ñ]|cómo|está/i.test(t)) return 'es'
  if (/[çœæ]|pourquoi|bonjour|\bça\b/i.test(t)) return 'fr'
  if (/[äöüß]|nicht\b|wie geht/i.test(t)) return 'de'
  if (/perché|ciao\b|grazie|più/i.test(t)) return 'it'
  if (/[ãõ]|você|não|olá/i.test(t)) return 'pt'
  if (/[A-Za-z]/.test(t)) return 'en'
  return null
}

function langTag(lang: PairLang): string {
  return TRANSLATE_LANGS.find((l) => l.id === lang)?.tag ?? lang.toUpperCase()
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
  const inflightTranslate = useRef<string | null>(null)
  const translateRetries = useRef<Map<string, number>>(new Map())
  const translateFiles = useRef<Map<string, AttachPayload[]>>(new Map())
  const translateTimer = useRef(0)
  const pumpTranslateRef = useRef<() => void>(() => {})
  const generateNotesRef = useRef<() => void>(() => {})
  const exportAfterNotes = useRef(false)
  const tickRef = useRef(0)
  const [consent, setConsent] = useState<boolean | null>(null)
  const consentRef = useRef<boolean | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)
  const pendingMic = useRef<(() => void) | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [railHover, setRailHover] = useState(false)
  const [railDismissed, setRailDismissed] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const requestClearRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!clearOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setClearOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearOpen])

  useEffect(() => {
    void fetchMe().then((me) => {
      const ok = me ? Boolean(me.consent) : true
      consentRef.current = ok
      setConsent(ok)
    })
  }, [])

  const guardMic = (fn: () => void) => {
    const running = stateRef.current.run === 'listen' || stateRef.current.run === 'record'
    if (running || consentRef.current === true) {
      fn()
      return
    }
    pendingMic.current = fn
    if (consentRef.current === null) {
      void fetchMe().then((me) => {
        const ok = me ? Boolean(me.consent) : true
        consentRef.current = ok
        setConsent(ok)
        if (ok) {
          const next = pendingMic.current
          pendingMic.current = null
          next?.()
        } else {
          setConsentOpen(true)
        }
      })
      return
    }
    setConsentOpen(true)
  }

  const acceptConsent = () => {
    void authApi('/api/me/consent', { method: 'POST', body: JSON.stringify({ consent: true }) }).then(() => {
      consentRef.current = true
      setConsent(true)
      setConsentOpen(false)
      const next = pendingMic.current
      pendingMic.current = null
      next?.()
    })
  }

  const clearTranslateTimer = () => {
    if (translateTimer.current) {
      window.clearTimeout(translateTimer.current)
      translateTimer.current = 0
    }
  }

  const releaseTranslateGate = (pairId?: string | null) => {
    clearTranslateTimer()
    if (pairId) askedTranslate.current.delete(pairId)
    inflightTranslate.current = null
  }

  useEffect(() => {
    const api = window.api
    const syncWorkspace = () => {
      const s = stateRef.current
      api.send({ type: 'set_translate_from', language: s.translateFrom === 'auto' ? null : s.translateFrom })
      api.send({ type: 'set_translate_to', lang: s.translateTo })
      api.send({ type: 'set_workspace', mode: s.workspaceMode })
      if (s.workspaceMode !== 'translate') {
        api.send({ type: 'set_lang', language: s.lang === 'auto' ? null : s.lang })
      }
    }
    const offEvent = api.onEvent((e) => {
      if (e.type === 'ready') syncWorkspace()
      dispatch({ type: 'engine', ev: e })
      if (e.type === 'question' && stateRef.current.workspaceMode === 'meeting' && stateRef.current.translateOn) {
        const text = e.text ?? ''
        if (!isTranslatePrompt(text) && !isCatchPrompt(text) && !isNotesPrompt(text) && !isSummaryPrompt(text)) {
          queueMicrotask(() => pumpTranslateRef.current())
        }
      }
      if (e.type === 'question' && stateRef.current.workspaceMode === 'translate') {
        const text = e.text ?? ''
        const s = stateRef.current
        if (!isTranslatePrompt(text) && s.translateFrom !== 'auto') {
          const heard = parseHeardLang(e.language, text)
          if (!matchesLockedFrom(text, s.translateFrom, heard)) return
        }
        if (!isTranslatePrompt(text)) {
          api.send({ type: 'cancel_generate' })
        }
        const last = stateRef.current.translatePairs[stateRef.current.translatePairs.length - 1]
        if (last && !last.translation && normOriginal(last.original) === normOriginal(text)) {
          askedTranslate.current.delete(last.id)
          queueMicrotask(() => pumpTranslateRef.current())
        }
      }
      // Only LLM `done` releases the translate gate. STT `error` events must not
      // drop an in-flight translation — that is what made "ask again" hang.
      if (e.type !== 'done') return
      const id = inflightTranslate.current
      clearTranslateTimer()
      inflightTranslate.current = null
      queueMicrotask(() => {
        if (id) {
          const row = stateRef.current.translatePairs.find((p) => p.id === id)
          if (row && (row.translation || '').trim()) {
            dispatch({ type: 'release_translate' })
          } else if (row && !(row.translation || '').trim()) {
            const n = (translateRetries.current.get(id) || 0) + 1
            translateRetries.current.set(id, n)
            if (n <= 2) askedTranslate.current.delete(id)
            else dispatch({ type: 'fail_translate', id })
          }
        }
        pumpTranslateRef.current()
      })
    })
    const offShortcut = api.onShortcut((k) => {
      const mode = stateRef.current.workspaceMode
      if (k === 'f2') guardMic(() => api.send({ type: 'manual' }))
      else if (k === 'f3') guardMic(() => api.send({ type: 'toggle_listen' }))
      else if (k === 'f4') requestClearRef.current()
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
      if (k === 'a') guardMic(() => window.api.send({ type: 'toggle_listen' }))
      else if (k === 'c') copyLatest()
      else if (k === 'x') requestClearRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyLatest])

  const doClear = useCallback(() => {
    askedTranslate.current.clear()
    window.api.send({ type: 'cancel_generate' })
    releaseTranslateGate()
    translateRetries.current.clear()
    window.api.send({ type: 'clear' })
    dispatch({ type: 'clear' })
    setClearOpen(false)
  }, [])

  const handleClear = useCallback(() => {
    const s = stateRef.current
    const empty =
      s.meetingLines.length === 0 &&
      s.turns.length === 0 &&
      s.translatePairs.length === 0 &&
      !s.notesRaw.trim() &&
      !s.catchNotes.some((note) => note.text.trim()) &&
      !s.partial.trim()
    if (empty) {
      doClear()
      return
    }
    setClearOpen(true)
  }, [doClear])
  requestClearRef.current = handleClear
  const handleAsk = useCallback((text: string, files?: AttachPayload[]) => {
    dispatch({ type: 'ask_start' })
    window.api.send({ type: 'ask', text, files })
  }, [])

  const handleOpacity = useCallback((n: number) => {
    window.api.setOpacity(n)
    dispatch({ type: 'opacity', value: n })
  }, [])

  useEffect(() => {
    window.api.setOpacity(state.opacity)
  }, [state.opacity])

  const handlePinned = useCallback((b: boolean) => {
    window.api.setPinned(b)
    dispatch({ type: 'pinned', value: b })
  }, [])

  const handleMicMuted = useCallback((muted: boolean) => {
    window.api.send({ type: 'set_mic_muted', muted })
    dispatch({ type: 'mic_muted', muted })
    dispatch({
      type: 'engine',
      ev: { type: 'status', text: muted ? 'Microphone muted' : 'Microphone on' },
    })
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
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text:
          lang === 'auto'
            ? 'Speech recognition · Auto · all supported languages'
            : `Speech recognition · ${targetName(lang)} only`,
      },
    })
  }, [])

  const handleTranslateFrom = useCallback((lang: Lang) => {
    const s = stateRef.current
    if (lang === s.translateFrom) return
    persistTranslatePair(lang, s.translateTo)
    window.api.send({ type: 'set_translate_from', language: lang === 'auto' ? null : lang })
    dispatch({ type: 'translate_from', lang })
    const fromName = lang === 'auto' ? 'Auto' : targetName(lang)
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text: lang === 'auto'
          ? `Hear Auto · captions ${targetName(s.translateTo)}`
          : lang === s.translateTo
            ? `Hear ${fromName} · same as captions`
            : `Hear ${fromName} only · captions ${targetName(s.translateTo)}`,
      },
    })
  }, [])

  const handleSwapTranslate = useCallback(() => {
    const s = stateRef.current
    const next = swapTranslatePair(s.translateFrom, s.translateTo, s.heardLang)
    if (next.from === s.translateFrom && next.to === s.translateTo) return
    persistTranslatePair(next.from, next.to)
    if (next.from !== s.translateFrom) {
      window.api.send({ type: 'set_translate_from', language: next.from === 'auto' ? null : next.from })
      dispatch({ type: 'translate_from', lang: next.from })
    }
    if (next.to !== s.translateTo) {
      const stuck = inflightTranslate.current
      window.api.send({ type: 'cancel_generate' })
      window.api.send({ type: 'set_translate_to', lang: next.to })
      releaseTranslateGate(stuck)
      dispatch({ type: 'translate_to', lang: next.to })
      queueMicrotask(() => pumpTranslateRef.current())
    }
    const fromName = next.from === 'auto' ? 'Auto' : targetName(next.from)
    dispatch({
      type: 'engine',
      ev: { type: 'status', text: `Captions · ${fromName} → ${targetName(next.to)}` },
    })
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
    if (mode === 'translate') {
      window.api.send({ type: 'cancel_generate' })
      window.api.send({ type: 'set_translate_from', language: s.translateFrom === 'auto' ? null : s.translateFrom })
      window.api.send({ type: 'set_translate_to', lang: s.translateTo })
    } else {
      window.api.send({ type: 'set_lang', language: s.lang === 'auto' ? null : s.lang })
    }
    window.api.send({ type: 'set_workspace', mode })
    dispatch({ type: 'workspace', mode })
    setComposeOpen(false)
    setRailHover(false)
    setRailDismissed(false)
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text:
          mode === 'translate'
            ? 'Mode · Translate'
            : mode === 'interview'
              ? 'Mode · Q&A'
              : 'Mode · AI Listening Assistant',
      },
    })
  }, [])

  const handlePrimary = useCallback(() => {
    const s = stateRef.current
    if (s.workspaceMode === 'interview') {
      if (s.run === 'record') return
      guardMic(() => window.api.send({ type: 'toggle_listen' }))
      return
    }
    if (s.workspaceMode === 'meeting') {
      if (s.run === 'listen' || s.run === 'record') {
        window.api.send({ type: 'toggle_listen' })
        dispatch({ type: 'meeting_ended' })
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Listening stopped' } })
        queueMicrotask(() => generateNotesRef.current())
        return
      }
      if (s.meetingEnded || s.meetingStartedAt == null) {
        dispatch({ type: 'listen_new' })
      } else {
        dispatch({ type: 'meeting_clock', startedAt: Date.now() - s.meetingElapsedMs, elapsedMs: s.meetingElapsedMs })
      }
      guardMic(() => window.api.send({ type: 'toggle_listen' }))
      return
    }
    if (s.run === 'record') return
    guardMic(() => {
      window.api.send({ type: 'set_workspace', mode: 'translate' })
      window.api.send({ type: 'set_translate_from', language: s.translateFrom === 'auto' ? null : s.translateFrom })
      window.api.send({ type: 'set_translate_to', lang: s.translateTo })
      window.api.send({ type: 'toggle_listen' })
    })
  }, [])

  const handleRecord = useCallback(() => {
    guardMic(() => window.api.send({ type: 'manual' }))
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

  const handleTranslateTo = useCallback((lang: PairLang) => {
    if (lang === stateRef.current.translateTo) return
    const s = stateRef.current
    persistTranslatePair(s.translateFrom, lang)
    const stuck = inflightTranslate.current
    window.api.send({ type: 'cancel_generate' })
    window.api.send({ type: 'set_translate_to', lang })
    releaseTranslateGate(stuck)
    dispatch({ type: 'translate_to', lang })
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text:
          s.workspaceMode === 'translate'
            ? s.translateFrom !== 'auto' && s.translateFrom === lang
              ? `Translate to ${targetName(lang)} · same as From`
              : `Translate to ${targetName(lang)}`
            : `Notes language · ${targetName(lang)}`,
      },
    })
    queueMicrotask(() => pumpTranslateRef.current())
  }, [])

  const askTranslate = useCallback((text: string, pairId?: string) => {
    if (inflightTranslate.current) return
    const s = stateRef.current
    const id = pairId || `cap-${Date.now()}`
    const pair = pairId ? s.translatePairs.find((p) => p.id === pairId) : undefined
    const sameLang = pair?.from ? pair.from === s.translateTo : looksLikeTarget(text, s.translateTo)
    if (sameLang) {
      askedTranslate.current.add(id)
      dispatch({ type: 'fill_translate', id, translation: text, passthrough: true })
      queueMicrotask(() => pumpTranslateRef.current())
      return
    }
    const target = targetName(s.translateTo)
    inflightTranslate.current = id
    askedTranslate.current.add(id)
    dispatch({ type: 'bind_translate', id })
    window.api.send({
      type: 'ask',
      mode: 'translate',
      text: `[NOD_TRANSLATE:${id}]\n${TRANSLATE_PREFIX}${target}. Output only the translation:\n\n${text}`,
      files: translateFiles.current.get(id),
    })
    translateFiles.current.delete(id)
    clearTranslateTimer()
    translateTimer.current = window.setTimeout(() => {
      if (inflightTranslate.current !== id) return
      inflightTranslate.current = null
      const n = (translateRetries.current.get(id) || 0) + 1
      translateRetries.current.set(id, n)
      if (n <= 2) askedTranslate.current.delete(id)
      else dispatch({ type: 'fail_translate', id })
      dispatch({ type: 'release_translate' })
      dispatch({
        type: 'engine',
        ev: { type: 'status', text: n <= 2 ? 'Translation timed out — retrying' : 'Translation timed out' },
      })
      pumpTranslateRef.current()
    }, 25000)
  }, [])

  const pumpTranslate = useCallback(() => {
    const s = stateRef.current
    if (inflightTranslate.current) return
    if (s.workspaceMode === 'meeting' && s.translateOn) {
      const next = s.meetingLines.find((line) => !line.translation && !askedTranslate.current.has(line.id))
      if (next) askTranslate(next.text, next.id)
      return
    }
    if (s.workspaceMode !== 'translate') return
    const next = s.translatePairs.find(
      (p) => !p.translation && !p.failed && !askedTranslate.current.has(p.id) && !isTranslatePrompt(p.original),
    )
    if (next) askTranslate(next.original, next.id)
  }, [askTranslate])
  pumpTranslateRef.current = pumpTranslate

  const handleTranslateTyped = useCallback((text: string, files?: AttachPayload[]) => {
    const original = text.trim() || (files?.length ? files.map((f) => f.name).join(', ') : '')
    const s = stateRef.current
    const last = s.translatePairs[s.translatePairs.length - 1]
    const sameLine =
      !files?.length &&
      last &&
      normOriginal(last.original) === normOriginal(original) &&
      (last.to || s.translateTo) === s.translateTo
    if (sameLine && last) {
      if (inflightTranslate.current === last.id) return
      askedTranslate.current.delete(last.id)
      translateRetries.current.delete(last.id)
      if (last.translation || last.failed) dispatch({ type: 'retry_translate', id: last.id })
      queueMicrotask(() => pumpTranslateRef.current())
      return
    }
    const id = `typed-${Date.now()}`
    dispatch({ type: 'seed_translate', text: original, id })
    if (files?.length) translateFiles.current.set(id, files)
    queueMicrotask(() => pumpTranslateRef.current())
  }, [])

  useEffect(() => {
    if (state.workspaceMode === 'meeting' && state.translateOn) {
      pumpTranslate()
      return
    }
    if (state.workspaceMode !== 'translate') return
    pumpTranslate()
  }, [state.translatePairs, state.meetingLines, state.translateOn, state.workspaceMode, pumpTranslate])

  const handleGenerateSummary = useCallback((note?: string, files?: AttachPayload[]) => {
    const s = stateRef.current
    if (note || files?.length) {
      dispatch({ type: 'expect_meeting_ask' })
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

  const generateNotes = useCallback(() => {
    const s = stateRef.current
    if (!s.meetingLines.length) {
      dispatch({ type: 'engine', ev: { type: 'status', text: 'No transcript to note yet.' } })
      return
    }
    dispatch({ type: 'expect_notes' })
    window.api.send({ type: 'ask', text: notesPrompt(s.listenScene, s.meetingLines, s.translateTo), mode: 'notes' })
  }, [])
  generateNotesRef.current = generateNotes

  const handleCatchUp = useCallback(() => {
    const s = stateRef.current
    const windowed = lastTwoMinutes(s.meetingLines)
    if (!windowed.length) {
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Nothing to catch up yet.' } })
      return
    }
    dispatch({
      type: 'expect_catch',
      title: 'Catch up · last 2 min',
    })
    window.api.send({ type: 'ask', text: catchupPrompt(windowed, '', s.translateTo), mode: 'catchup' })
  }, [])

  const handleListenAsk = useCallback((text: string) => {
    const s = stateRef.current
    const question = text.trim()
    if (!question) return
    dispatch({ type: 'expect_catch', kind: 'ask', title: 'Ask', question })
    window.api.send({
      type: 'ask',
      text: askPrompt(askContext(s.meetingLines, s.meetingEnded), question, s.translateTo),
      mode: 'listen_ask',
    })
  }, [])

  const copyPairField = useCallback((pair: TranslatePair, field: 'original' | 'translation') => {
    const text = (field === 'translation' ? pair.translation : pair.original).trim()
    if (!text) {
      dispatch({ type: 'engine', ev: { type: 'status', text: field === 'translation' ? 'Nothing to copy yet.' : 'Nothing to copy.' } })
      return
    }
    window.api.copy(text)
    dispatch({ type: 'engine', ev: { type: 'status', text: field === 'translation' ? 'Copied translation' : 'Copied original' } })
  }, [])

  const handleRetryTranslate = useCallback((id: string) => {
    if (inflightTranslate.current === id) return
    askedTranslate.current.delete(id)
    translateRetries.current.delete(id)
    dispatch({ type: 'retry_translate', id })
    queueMicrotask(() => pumpTranslateRef.current())
  }, [])

  const writePdf = useCallback(async () => {
    const s = stateRef.current
    const when = new Date().toLocaleString()
    const blocks: Array<{ kind: 'h1' | 'h2' | 'p' | 'meta'; text: string }> = []
    let title = 'Nod'

    if (s.workspaceMode === 'translate') {
      title = 'Nod captions'
      blocks.push({ kind: 'h1', text: 'Nod captions' })
      blocks.push({ kind: 'meta', text: `Auto → ${langTag(s.translateTo)} · ${when}` })
      if (s.translatePairs.length === 0) {
        blocks.push({ kind: 'p', text: 'No captions yet.' })
      } else {
        for (const p of s.translatePairs) {
          blocks.push({ kind: 'p', text: `${p.ts}  ${p.original || '—'}` })
          blocks.push({ kind: 'p', text: `     ${p.translation || '…'}` })
        }
      }
    } else if (s.workspaceMode === 'interview') {
      title = 'Nod answers'
      blocks.push({ kind: 'h1', text: 'Nod answers' })
      blocks.push({ kind: 'meta', text: `Exported ${when}` })
      if (s.turns.length === 0) {
        blocks.push({ kind: 'p', text: 'No answers yet.' })
      } else {
        s.turns.forEach((turn, i) => {
          blocks.push({ kind: 'h2', text: `Question ${i + 1}` })
          blocks.push({ kind: 'p', text: turn.q || '—' })
          blocks.push({ kind: 'h2', text: 'Answer' })
          blocks.push({ kind: 'p', text: turn.a || '…' })
        })
      }
      const interviewNotes = parseNotes(s.notesRaw)
      for (const section of exportNoteSections('interview', interviewNotes)) {
        blocks.push({ kind: 'h2', text: section.title })
        if (section.items.length) {
          for (const item of section.items) blocks.push({ kind: 'p', text: item })
        } else {
          blocks.push({ kind: 'p', text: '—' })
        }
      }
    } else {
      const scene = s.listenScene[0].toUpperCase() + s.listenScene.slice(1)
      title = `Nod ${scene} notes`
      const lines = s.meetingLines
      const doc = parseNotes(s.notesRaw)
      blocks.push({ kind: 'h1', text: `Nod ${scene} notes` })
      blocks.push({ kind: 'meta', text: `Exported ${when}` })
      for (const section of exportNoteSections(s.listenScene, doc)) {
        blocks.push({ kind: 'h2', text: section.title })
        if (section.items.length) {
          for (const item of section.items) blocks.push({ kind: 'p', text: item })
        } else {
          blocks.push({ kind: 'p', text: '—' })
        }
      }
      for (const note of s.catchNotes) {
        if (!note.text.trim()) continue
        blocks.push({ kind: 'h2', text: note.title })
        blocks.push({ kind: 'p', text: note.text.trim() })
      }
      blocks.push({ kind: 'h2', text: 'Transcript' })
      if (lines.length === 0) blocks.push({ kind: 'p', text: 'No transcript lines.' })
      else {
        for (const ln of lines) {
          blocks.push({ kind: 'p', text: `${ln.ts}  ${ln.text}` })
          if (s.translateOn && ln.translation) blocks.push({ kind: 'p', text: `     ${ln.translation}` })
        }
      }
    }

    try {
      const dest = await window.api.exportPdf({ title, blocks })
      if (!dest) {
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Export cancelled' } })
        return
      }
      dispatch({ type: 'engine', ev: { type: 'status', text: `Downloaded ${dest}` } })
    } catch (err) {
      dispatch({ type: 'engine', ev: { type: 'status', text: `PDF export failed: ${err instanceof Error ? err.message : String(err)}` } })
    }
  }, [])

  const handleExportPdf = useCallback(() => {
    const s = stateRef.current
    const listenSurface = s.workspaceMode === 'meeting' || s.workspaceMode === 'interview'
    const needsNotes = listenSurface && s.meetingLines.length > 0 && !s.notesRaw.trim()
    if (needsNotes) {
      exportAfterNotes.current = true
      if (s.busy) {
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Waiting for notes, then exporting PDF…' } })
        return
      }
      generateNotes()
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Summarizing all sections, then exporting PDF…' } })
      return
    }
    void writePdf()
  }, [generateNotes, writePdf])

  useEffect(() => {
    if (!exportAfterNotes.current || state.busy) return
    exportAfterNotes.current = false
    void writePdf()
  }, [state.busy, state.notesRaw, writePdf])

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
  const study = state.workspaceMode === 'interview'
  const hideRail = () => {
    setRailDismissed(true)
    setComposeOpen(false)
    setRailHover(false)
  }
  const railOn = !study || (!railDismissed && (composeOpen || railHover || state.busy || listening))

  return (
    <div className="app">
      <TitleBar
        mode={state.workspaceMode}
        lang={state.lang}
        heardLang={state.heardLang}
        source={state.source}
        opacity={state.opacity}
        pinned={state.pinned}
        systemMuted={state.systemMuted}
        micMuted={state.micMuted}
        stealth={state.stealth}
        onMode={handleMode}
        onLang={handleLang}
        onSource={handleSource}
        onOpacity={handleOpacity}
        onPinned={handlePinned}
        onSystemMuted={handleSystemMuted}
        onMicMuted={handleMicMuted}
        onStealth={handleStealth}
        onFullScreen={() => dispatch({ type: 'view', view: 'fullscreen' })}
      />
      <div className={`workspace${study ? ' study' : ''}${study && railOn ? ' rail-on' : ''}`}>
        {study && (
          <div
            className="rail-hotzone"
            onMouseEnter={() => {
              setRailDismissed(false)
              setRailHover(true)
            }}
            title="Show controls"
          />
        )}
        <div
          className="rail-slot"
          onMouseEnter={() => {
            if (!study) return
            setRailDismissed(false)
            setRailHover(true)
          }}
          onMouseLeave={() => study && setRailHover(false)}
        >
          <SideRail
            mode={state.workspaceMode}
            run={state.run}
            autoOn={state.autoOn}
            bilingual={state.bilingual}
            onPrimary={handlePrimary}
            onRecord={handleRecord}
            onCopy={copyLatest}
            onClear={handleClear}
            onPause={handlePause}
            onMark={handleMark}
            onExport={() => { void handleExportPdf() }}
            onBilingual={() => dispatch({ type: 'bilingual', on: !state.bilingual })}
            onClose={study ? hideRail : undefined}
            meetingPaused={
              state.workspaceMode === 'meeting'
              && !listening
              && state.meetingStartedAt != null
              && !state.meetingEnded
            }
          />
        </div>
        {state.workspaceMode === 'translate' ? (
          <TranslatePane
            pairs={state.translatePairs}
            partial={state.partial}
            bindId={state.translateBindId}
            bilingual={state.bilingual}
            to={state.translateTo}
            from={state.translateFrom}
            heardFrom={state.translateFrom === 'auto' ? state.heardLang : state.translateFrom}
            source={state.source}
            onTranslate={handleTranslateTyped}
            onTranslateTo={handleTranslateTo}
            onTranslateFrom={handleTranslateFrom}
            onSwap={handleSwapTranslate}
            onCopyField={copyPairField}
            onRetry={handleRetryTranslate}
          />
        ) : (
          <ListenPane
            scene={state.workspaceMode === 'interview' ? 'interview' : state.listenScene}
            translateOn={state.translateOn}
            translateTo={state.translateTo}
            lines={state.meetingLines}
            partial={state.partial}
            elapsedLabel={elapsedLabel}
            listening={listening}
            ended={state.meetingEnded}
            catchNotes={state.catchNotes}
            notesRaw={state.notesRaw}
            busy={state.busy}
            qa={state.workspaceMode === 'interview'}
            qaSlot={
              <AnswerPane
                currentQ={state.currentQ}
                partial={state.partial}
                turns={state.turns}
                busy={state.busy}
                onAsk={handleAsk}
                onCompose={(on) => {
                  if (on) {
                    setRailDismissed(false)
                    setComposeOpen(true)
                    return
                  }
                  setComposeOpen(false)
                }}
              />
            }
            onScene={(scene) => {
              dispatch({ type: 'listen_scene', scene })
              if (scene === 'interview') handleMode('interview')
              else if (state.workspaceMode !== 'meeting') handleMode('meeting')
            }}
            onTranslate={(on) => {
              dispatch({ type: 'translate_on', on })
              if (on) queueMicrotask(() => pumpTranslateRef.current())
            }}
            onTranslateTo={handleTranslateTo}
            onCatchUp={handleCatchUp}
            onAsk={handleListenAsk}
          />
        )}
      </div>
      <StatusToast text={state.status} />
      {clearOpen && (
        <div className="consent-mask" onClick={() => setClearOpen(false)}>
          <div className="consent-card confirm-card" role="dialog" aria-labelledby="clear-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="clear-title">Clear this session?</h2>
            <p>This removes the transcript, notes, and answers on screen. You cannot undo it.</p>
            <div className="confirm-actions">
              <button className="confirm-keep" type="button" onClick={() => setClearOpen(false)} autoFocus>
                Keep
              </button>
              <button className="confirm-clear" type="button" onClick={doClear}>
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
      {consentOpen && (
        <div className="consent-mask">
          <div className="consent-card">
            <h2>Before you start recording</h2>
            <p>
              The first time you enable the microphone, Nod sends audio to AssemblyAI and text to a language model.
              This applies on the free trial, not only paid plans. Tell others in the room if they must know. You can
              delete stored history from Account. Read the <a href="/privacy">privacy policy</a> and{' '}
              <a href="/consent">consent note</a>.
            </p>
            <button className="keysetup-save" type="button" onClick={acceptConsent}>
              I agree — enable microphone
            </button>
            <button
              className="consent-later"
              type="button"
              onClick={() => {
                pendingMic.current = null
                setConsentOpen(false)
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
