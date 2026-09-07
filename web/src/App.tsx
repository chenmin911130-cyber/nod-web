import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AttachPayload } from './attach'
import type { AppConfig, AppState, AudioSource, EngineEvent, Lang, MeetingLine, PairLang, TranslatePair, ViewMode, WorkspaceMode } from './types'
import { TRANSLATE_LANGS } from './types'
import { PRODUCT_NAME } from './brand'
import { isWeb } from './platform'
import TitleBar, { TitleIcons } from './components/TitleBar'
import HistoryPane, { type HistorySession } from './components/HistoryPane'
import { restoreFromSession, restoreIdOfferable, restoreShouldNotAsk, applyMeetingResume, resumeResetsKept, sessionShouldOfferSave, sessionShouldOpenSavePrompt, shouldMarkKeptOnAck } from './historyRestore'
import { watchDiscardCommand, watchSaveCommand, watchStopShouldAutoKeepHistory, watchStopShouldOpenPhoneSave } from './watchSave'
import { watchLangPair, watchStatusMode } from './watchFace'
import { LISTEN_TAKEN_TEXT, shouldReleaseListen } from './listenTaken'
import { meetingRailIsPaused } from './meetingPause'
import SavePrompt from './components/SavePrompt'
import IphoneActions from './components/IphoneActions'
import SideRail from './components/SideRail'
import { IPHONE_COPY, canSwitchWorkspace, sameSpokenLine, sessionListening } from './iphoneCopy'
import SaveBanner from './components/SaveBanner'
import {
  KEEP_ACK_TIMEOUT_MS,
  applyKeepAck,
  applyKeepFailed,
  beginSave,
  bindLiveId,
  bumpGeneration,
  cancelCollect,
  emptySaveBook,
  keepAfterNotesStillValid,
  markOffered,
  savePromptSurface,
  type KeepAfterNotesJob,
  type SaveBook,
} from './sessionSave'
import { isTranslateChunk, looksLikeTarget, matchesLockedFrom, parseHeardLang, routeTranslateChunk, sttTag, translateAskIdAfterDone, translateDoneBelongsToAsk, translateDoneDecision, translateShouldPassthrough, wrongScriptForTarget } from './translateGate'
import { meetingLinesAfterTargetChange, nextMeetingLineToTranslate } from './meetingTranslate'
import { applyLineUpdate, applyLineTranslationRev, staleTranslateDone } from './meetingLines'
import { doneAffectsInterview } from './interviewDone'
import AnswerPane from './components/AnswerPane'
import ListenPane from './components/ListenPane'
import TranslatePane from './components/TranslatePane'
import StatusToast from './components/StatusToast'
import AutoOverlay from './components/AutoOverlay'
import KeySetup from './components/KeySetup'
import { api as authApi, fetchMe } from './auth'
import { isNativeApp, nativeGo } from './native'
import { usePhoneChrome } from './phoneChrome'
import { installWatchRemote, pushWatchStatus, setPreferWatchMic, takePhoneMic, watchListenControlShouldApplyMode, watchListenMode, watchShouldApplyMode, watchStartShouldPreferWatchMic } from './watch'
import { buildWatchFace } from './watchStatus'
import { isSpeaking, listenSessionShouldAutoSpeak, nextLiveUtterances, onSpeakingChange, readTtsMode, readTtsVoice, speakTranslation, speechTapShouldStop, stopSpeech, unlockSpeech, writeTtsMode, writeTtsVoice, type TtsMode, type TtsVoice } from './tts'
import { keepShouldWaitForNotes, shouldGenerateAutoReport, stopShouldReleaseListener } from './recordReport'
import {
  clearWatchReport,
  markWatchReport,
  pickWatchReportSession,
  readWatchReport,
  readWatchReportSnapshot,
  shouldRestoreWatchReport,
  snapshotFromWorkspace,
  snapshotToHistoryItems,
  writeWatchReportSnapshot,
} from './watchReport'
import {
  askContext,
  askPrompt,
  bindSpeakerName,
  isAskPrompt,
  isCatchPrompt,
  isNotesPrompt,
  notesPrompt,
  nodTag,
  outLangRule,
  capTranscript,
  notesLangActions,
  MEETING_SPEAKER_OPTIONS,
  exportNoteSections,
  parseNotes,
  promoteLectureSpeakers,
  promoteMeetingSpeakers,
  resolveSpeakerName,
  speakersExpected,
  listenSettingsBlocked,
  meetingSpeakerCount,
  meetingSpeakerId,
  setMeetingSpeaker,
  sectionTitle,
  sceneSectionOrder,
  type ListenScene,
  type MeetingSpeakerId,
} from './listen'
import { buildListenPdfDoc, type ListenPdfDoc } from './pdfTemplates'
import { applyDemoSeed, readDemoScene } from './demoSeed'
import { quotaLimitText, type QuotaFields } from './quotaCopy'

function isPendingCatchId(id: string): boolean {
  return id === '__pending__' || id.startsWith('__pending__:')
}

const PLACEHOLDER = 'Waiting for the next question…'
const STATUS_READY = 'Ready · F2 record / F3 listen / F4 clear'
const TRANSLATE_PREFIX = 'Translate to '
const TRANSLATE_PAIR_KEY = 'nod_translate_pair'
const NOTES_LANG_KEY = 'nod_notes_lang'

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

function readStoredNotesLang(): Lang | null {
  try {
    const raw = localStorage.getItem(NOTES_LANG_KEY)
    if (raw === 'auto' || isPairLang(raw)) return raw
  } catch {
    /* ignore */
  }
  return null
}

function persistNotesLang(lang: Lang) {
  try {
    localStorage.setItem(NOTES_LANG_KEY, lang)
  } catch {
    /* ignore */
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
  capture: 'off',
  engine: 'idle',
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
  meetingStartedAt: null,
  meetingPausedAt: null,
  meetingElapsedMs: 0,
  meetingEnded: false,
  translatePairs: [],
  translateFrom: storedPair?.from ?? 'auto',
  translateTo: storedPair?.to ?? 'en',
  notesLang: readStoredNotesLang() ?? 'auto',
  heardLang: null,
  translateAskId: '',
  translateBindId: '',
  translateBindRev: 0,
  listenScene: 'meeting' as ListenScene,
  translateOn: true,
  catchNotes: [],
  catchPendingTitle: '',
  catchAskId: '',
  notesRaw: '',
  notesAskId: '',
  speakerNames: {},
  speakerNameLocked: {},
  partialSpeaker: '',
  quota: null as { stt_seconds: number; stt_limit: number; llm_tokens: number; llm_limit: number; ok: boolean; sessions: number; session_limit: number; daily_cost_usd: number; daily_cost_limit: number; daily_stt_seconds: number; daily_stt_limit: number; quota_disabled?: boolean } | null,
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
  | { type: 'notes_lang'; lang: Lang }
  | { type: 'mark_action' }
  | { type: 'meeting_clock'; startedAt: number | null; elapsedMs: number }
  | { type: 'meeting_ended' }
  | { type: 'seed_translate'; text: string; id: string }
  | { type: 'bind_translate'; id: string; rev?: number }
  | { type: 'release_translate' }
  | { type: 'fill_translate'; id: string; translation: string; passthrough?: boolean }
  | { type: 'clear_translation'; id: string }
  | { type: 'retry_translate'; id: string }
  | { type: 'fail_translate'; id: string }
  | { type: 'ask_start' }
  | { type: 'seed_ask'; text: string }
  | { type: 'fail_ask'; text: string }
  | { type: 'listen_scene'; scene: ListenScene }
  | { type: 'translate_on'; on: boolean }
  | { type: 'listen_new' }
  | { type: 'meeting_resume' }
  | { type: 'expect_catch'; title?: string; kind?: 'catch' | 'ask'; question?: string }
  | { type: 'expect_notes' }
  | { type: 'rename_speaker'; id: string; name: string }
  | {
      type: 'restore_session'
      mode: WorkspaceMode
      scene: ListenScene
      lines: MeetingLine[]
      turns: AppState['turns']
      notes: string
      summary: string
      pairs: TranslatePair[]
    }

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

function meetingHasSaveableContent(s: AppState): boolean {
  return (
    s.meetingLines.length > 0
    || Boolean(s.partial.trim())
    || Boolean(s.notesRaw.trim())
    || s.catchNotes.some((note) => note.text.trim())
  )
}

function translateBindFromPrompt(text: string): string {
  const m = /^\[NOD_TRANSLATE:([^\]]+)\]/.exec(text)
  return m?.[1] ?? ''
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
      if (
        readDemoScene()
        && (ev.type === 'ready' || ev.type === 'keys_status' || ev.type === 'status')
      ) {
        return state
      }
      switch (ev.type) {
        case 'ready':
          return { ...state, status: STATUS_READY, capture: 'off', engine: 'idle' }
        case 'keys_status':
          return { ...state, keys: { hasLlm: ev.has_llm, hasStt: ev.has_stt } }
        case 'phase': {
          // ADR 0001: capture/engine are the two axes. A live session keeps
          // capture 'listening'/'recording', so autoOn + meeting clock stay on;
          // 'paused' freezes it; 'off' ends it. Engine busy keeps `busy` set.
          const capture = ev.capture
          const engine = ev.engine
          let autoOn = state.autoOn
          let view = state.view
          let meetingStartedAt = state.meetingStartedAt
          if (capture === 'listening' || capture === 'recording') {
            if (!isWeb && state.workspaceMode === 'interview' && !autoOn && view === 'workspace') view = 'focus'
            autoOn = true
            if (state.workspaceMode === 'meeting' && meetingStartedAt == null) meetingStartedAt = Date.now()
          } else if (capture === 'off') {
            autoOn = false
            if (view !== 'workspace') view = 'workspace'
          }
          const generating = Boolean(state.translateAskId || state.notesAskId)
          const interviewAsking = state.workspaceMode === 'interview' && state.busy
          let busy = state.busy
          if (engine === 'generating' || engine === 'transcribing') busy = true
          else if (engine === 'idle' && !generating && !interviewAsking) busy = false
          return { ...state, capture, engine, autoOn, view, busy, meetingStartedAt }
        }
        case 'listen_taken': {
          // Stolen STT must leave Listening. Do not clear Interview / Ask busy.
          const text = ev.text || LISTEN_TAKEN_TEXT
          return {
            ...state,
            status: text,
            capture: 'off',
            autoOn: false,
            view: 'workspace',
          }
        }
        case 'status':
          return { ...state, status: ev.text }
        case 'partial': {
          const text = ev.text ?? ''
          if (state.workspaceMode === 'translate' && state.translateFrom !== 'auto') {
            const heard = parseHeardLang(ev.language, text)
            if (text && !matchesLockedFrom(text, state.translateFrom, heard)) {
              return { ...state, partial: '', partialSpeaker: '' }
            }
          }
          const spoken = hasSpeechContent(text)
          return {
            ...state,
            partial: spoken ? text : '',
            partialSpeaker: spoken ? (ev.speaker || state.partialSpeaker) : '',
            speakerNames: spoken ? bindSpeakerName(state.speakerNames, ev.speaker, state.listenScene) : state.speakerNames,
          }
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
          if (isCatchPrompt(text) || isAskPrompt(text)) {
            const pending = state.catchNotes.find((note) => isPendingCatchId(note.id))
            return {
              ...state,
              catchAskId: qid,
              catchNotes: pending
                ? state.catchNotes.map((note) => (note.id === pending.id ? { ...note, id: qid } : note))
                : [
                    ...state.catchNotes,
                    {
                      id: qid,
                      kind: isAskPrompt(text) ? 'ask' : 'catch',
                      title: state.catchPendingTitle || (isAskPrompt(text) ? 'Ask' : 'Summary'),
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
            const scene = state.listenScene
            let speakerNames = bindSpeakerName(state.speakerNames, ev.speaker, scene)
            const meetingLines = [...state.meetingLines, {
              id: qid,
              ts: formatTs(state.meetingStartedAt),
              text,
              at: Date.now(),
              speaker: ev.speaker,
              lang: sttTag(ev.language),
            }]
            if (scene === 'lecture') {
              speakerNames = promoteLectureSpeakers(meetingLines, speakerNames, state.speakerNameLocked)
            } else {
              speakerNames = promoteMeetingSpeakers(meetingLines, speakerNames, state.speakerNameLocked, scene)
            }
            return {
              ...state,
              meetingLines,
              speakerNames,
              currentQ: text,
              currentQId: qid,
              partial: '',
              partialSpeaker: '',
              heardLang: heard ?? state.heardLang,
            }
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
              from: state.translateFrom !== 'auto' ? state.translateFrom : sttTag(ev.language),
            }]
            return { ...state, translatePairs, currentQ: text, currentQId: qid, partial: '', heardLang: heard ?? state.heardLang }
          }
          const pending = state.turns.findIndex((t) => t.id === '__pending_ask__')
          const turns = state.turns.slice()
          if (pending >= 0) turns[pending] = { ...turns[pending], id: qid, q: text }
          else turns.push({ id: qid, q: text, a: '' })
          return { ...state, turns, currentQ: text, currentQId: qid, partial: '', busy: true, heardLang: heard ?? state.heardLang }
        }
        case 'line_update': {
          // A continuation of the open meeting line: replace its text, bump rev,
          // clear the stale translation, and clear the LIVE partial (the merged
          // line is no longer a half-sentence being transcribed). Unknown ids are
          // ignored so a stale event after clear / workspace switch never
          // recreates a line.
          if (state.workspaceMode !== 'meeting') return state
          const meetingLines = applyLineUpdate(state.meetingLines, ev.id, ev.text, ev.language, ev.speaker, ev.rev)
          const currentQ = state.currentQId === ev.id ? ev.text : state.currentQ
          return { ...state, meetingLines, currentQ, partial: '', partialSpeaker: '' }
        }
        case 'chunk': {
          let translatePairs = state.translatePairs
          let translateAskId = state.translateAskId
          let catchNotes = state.catchNotes
          let catchAskId = state.catchAskId
          let notesRaw = state.notesRaw
          let notesAskId = state.notesAskId
          let meetingLines = state.meetingLines
          {
            const byId = ev.id ? catchNotes.find((note) => note.id === ev.id) : undefined
            const foreign = Boolean(ev.id) && (
              ev.id === state.translateAskId
              || ev.id === state.notesAskId
            )
            const pending = !byId && !foreign
              ? catchNotes.find((note) => isPendingCatchId(note.id))
              : undefined
            const target = byId || pending
            if (target) {
              const nextId = ev.id || target.id
              catchNotes = catchNotes.map((note) =>
                note.id === target.id ? { ...note, id: nextId, text: note.text + (ev.text ?? '') } : note,
              )
              catchAskId = nextId
            }
          }
          if (notesAskId === '__pending__' || (ev.id && ev.id === notesAskId)) {
            notesRaw += ev.text ?? ''
            notesAskId = ev.id || notesAskId
          }
          const translateChunk = isTranslateChunk(translateAskId, ev.id)
          if (translateChunk) {
            const route = routeTranslateChunk(
              state.workspaceMode,
              state.translateOn,
              meetingLines.length > 0,
              translatePairs.length > 0,
            )
            if (route === 'meeting') meetingLines = applyLineTranslationRev(meetingLines, state.translateBindId, state.translateBindRev, ev.text ?? '')
            else if (route === 'pairs') translatePairs = applyTranslateChunk(translatePairs, state.translateBindId, ev.text ?? '')
          }
          if (state.workspaceMode === 'interview' && state.turns.length) {
            const byId = ev.id ? state.turns.findIndex((t) => t.id === ev.id) : -1
            const fallback = byId < 0 && !ev.id ? state.turns.length - 1 : state.turns.findIndex((t) => !t.a)
            const idx = byId >= 0 ? byId : fallback
            if (idx >= 0) {
              const turns = state.turns.slice()
              const row = turns[idx]
              turns[idx] = { ...row, id: ev.id || row.id, a: row.a + (ev.text ?? '') }
              return { ...state, turns, translatePairs, translateAskId, catchNotes, catchAskId, notesRaw, notesAskId, meetingLines }
            }
          }
          return { ...state, translatePairs, translateAskId, catchNotes, catchAskId, notesRaw, notesAskId, meetingLines }
        }
        case 'done': {
          if (state.workspaceMode === 'interview' && !doneAffectsInterview(state.turns, ev.id)) {
            return state
          }
          const waitingAsk = state.catchNotes.some((note) => isPendingCatchId(note.id))
          let turns = state.turns
          if (state.workspaceMode === 'interview' && ev.ok === false && ev.id && turns.length) {
            const i = turns.findIndex((t) => t.id === ev.id)
            if (i >= 0 && !turns[i].a) {
              turns = turns.slice()
              turns[i] = { ...turns[i], a: state.status.startsWith('Generation failed') ? state.status : 'Generation stopped. Please try again.' }
            }
          }
          return {
            ...state,
            turns,
            busy: waitingAsk,
            status: waitingAsk ? state.status : 'Ready',
            translateAskId: translateAskIdAfterDone(state.translateAskId, ev.id),
            catchAskId: waitingAsk ? state.catchAskId : '',
            notesAskId: '',
          }
        }
        case 'error': {
          const msg = ev.text || 'Generation failed'
          if (state.workspaceMode === 'interview' && state.turns.length) {
            const i = state.turns.findIndex((t) => !t.a)
            if (i >= 0) {
              const turns = state.turns.slice()
              turns[i] = { ...turns[i], a: msg }
              return { ...state, turns, status: msg, busy: false }
            }
          }
          return { ...state, status: msg, busy: false }
        }
        case 'auth_required':
          if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
            nativeGo('/login?next=/app', true)
          }
          return state
        case 'quota':
          return {
            ...state,
            quota: {
              ok: ev.ok,
              stt_seconds: ev.stt_seconds,
              stt_limit: ev.stt_limit,
              daily_stt_seconds: ev.daily_stt_seconds ?? 0,
              daily_stt_limit: ev.daily_stt_limit ?? 0,
              llm_tokens: ev.llm_tokens,
              llm_limit: ev.llm_limit,
              sessions: ev.sessions ?? 0,
              session_limit: ev.session_limit ?? 0,
              daily_cost_usd: ev.daily_cost_usd ?? 0,
              daily_cost_limit: ev.daily_cost_limit ?? 0,
              quota_disabled: ev.quota_disabled,
            },
          }
        case 'quota_exceeded':
          return { ...state, busy: false, status: quotaLimitText(ev.reason, state.quota as unknown as QuotaFields) }
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
        meetingStartedAt: null,
        meetingElapsedMs: 0,
        meetingEnded: false,
        speakerNames: {},
        speakerNameLocked: {},
        partialSpeaker: '',
        translatePairs: [],
        translateAskId: '',
        translateBindId: '',
        catchNotes: [],
        catchPendingTitle: '',
        catchAskId: '',
        notesRaw: '',
        notesAskId: '',
      }
    case 'workspace':
      return { ...state, workspaceMode: action.mode, view: 'workspace' }
    case 'restore_session': {
      const lastTurn = action.turns[action.turns.length - 1]
      return {
        ...state,
        workspaceMode: action.mode,
        listenScene: action.scene,
        meetingLines: action.lines,
        turns: action.turns,
        currentQ: lastTurn?.q || PLACEHOLDER,
        currentQId: lastTurn?.id || '',
        notesRaw: action.notes,
        translatePairs: action.pairs,
        meetingStartedAt: Date.now(),
        meetingEnded: false,
        meetingElapsedMs: 0,
        view: 'workspace',
        partial: '',
      }
    }
    case 'listen_scene':
      return { ...state, listenScene: action.scene }
    case 'translate_on':
      return { ...state, translateOn: action.on }
    case 'rename_speaker': {
      const id = action.id.trim()
      const name = action.name.trim()
      if (!id || !name) return state
      return {
        ...state,
        speakerNames: { ...state.speakerNames, [id]: name },
        speakerNameLocked: { ...state.speakerNameLocked, [id]: true },
      }
    }
    case 'listen_new':
      return {
        ...state,
        meetingLines: [],
        speakerNames: {},
        speakerNameLocked: {},
        partialSpeaker: '',
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
    case 'meeting_resume':
      return applyMeetingResume(state)
    case 'expect_catch': {
      const kind = action.kind || 'catch'
      const title = action.title || (kind === 'ask' ? 'Ask' : 'Summary')
      const pendingId = `__pending__:${Date.now()}-${state.catchNotes.length}-${Math.random().toString(36).slice(2, 8)}`
      return {
        ...state,
        catchAskId: pendingId,
        catchPendingTitle: title,
        catchNotes: [
          ...state.catchNotes,
          {
            id: pendingId,
            kind,
            title,
            question: action.question || '',
            text: '',
          },
        ],
        busy: true,
        status: kind === 'ask' ? 'Answering…' : 'Catching up…',
      }
    }
    case 'expect_notes':
      return { ...state, notesAskId: '__pending__', notesRaw: '', busy: true, status: 'Writing notes…', translateBindId: '', translateAskId: '' }
    case 'translate_from':
      return { ...state, translateFrom: action.lang }
    case 'translate_to': {
      // Decoupled: changing the translation target must NOT rewrite the notes
      // language. The Meeting notes selector dispatches notes_lang separately.
      if (action.lang === state.translateTo) return { ...state, translateTo: action.lang }
      // After End, settings apply to the next capture. Keep the same line
      // objects so existing transcript text (and the pump effect) stay put.
      if (state.meetingEnded) return { ...state, translateTo: action.lang }
      // A meeting line that gave up (translateFailed) becomes retryable under a
      // new target — reset the give-up flag. Its translation stays empty; the
      // caller clears the asked/retry refs so pump re-picks these lines.
      return {
        ...state,
        translateTo: action.lang,
        meetingLines: meetingLinesAfterTargetChange(state.meetingLines, state.translateTo, action.lang),
      }
    }
    case 'notes_lang':
      return { ...state, notesLang: action.lang }
    case 'mark_action': {
      if (state.meetingLines.length === 0) return state
      const meetingLines = state.meetingLines.slice()
      const last = meetingLines[meetingLines.length - 1]
      meetingLines[meetingLines.length - 1] = { ...last, marked: true }
      return { ...state, meetingLines, status: 'Marked last line as action' }
    }
    case 'meeting_clock':
      // 不重置 meetingEnded：时钟 tick 若在 Stop 与 state:idle 事件之间触发，
      // 会把刚结束的会议打回"暂停"态（结束提示/笔记不显示，主按钮变续听）
      return { ...state, meetingStartedAt: action.startedAt, meetingElapsedMs: action.elapsedMs }
    case 'meeting_ended': {
      // 停止监听会取消服务端在途生成（不发 done），把还没写完的 ask/catch 卡标出来
      const catchNotes = state.catchNotes.map((note) =>
        !note.text.trim() && (isPendingCatchId(note.id) || note.id === state.catchAskId)
          ? { ...note, text: '(Interrupted — listening stopped)' }
          : note,
      )
      return {
        ...state,
        meetingEnded: true,
        catchNotes,
        catchAskId: '',
        notesAskId: state.notesAskId === '__pending__' ? '' : state.notesAskId,
      }
    }
    case 'seed_translate': {
      const ts = formatClock()
      // Typed input has no STT from-tag, so translateSourceTag would fall back
      // to 'en' and the language chip always showed EN. Guess a CJK script tag
      // from glyphs (zh/ja) so the chip reflects the real source language.
      const from: PairLang | undefined = looksLikeTarget(action.text, 'zh') ? 'zh' : looksLikeTarget(action.text, 'ja') ? 'ja' : undefined
      const translatePairs = [...state.translatePairs, { id: action.id, ts, original: action.text, translation: '', to: state.translateTo, from }]
      return { ...state, translatePairs, currentQ: action.text, translateBindId: action.id }
    }
    case 'bind_translate':
      return { ...state, translateBindId: action.id, translateBindRev: action.rev ?? 0 }
    case 'release_translate':
      return { ...state, translateBindId: '', translateBindRev: 0, busy: false }
    case 'fill_translate': {
      const translatePairs = state.translatePairs.map((p) =>
        p.id === action.id
          ? { ...p, translation: action.translation, to: state.translateTo, failed: false, passthrough: Boolean(action.passthrough) }
          : p,
      )
      // meeting 模式下 passthrough（原文已是目标语言）也要写进 transcript 行，
      // 否则该行翻译永远空白且被 askedTranslate 标记后不再重试
      const meetingLines = state.meetingLines.map((ln) =>
        ln.id === action.id ? { ...ln, translation: action.translation, translateFailed: false } : ln,
      )
      return { ...state, translatePairs, meetingLines, translateBindId: '', busy: false }
    }
    case 'clear_translation': {
      // 翻译被取消/中断时清掉半截译文，避免 pump 把它当已完成而跳过
      const translatePairs = state.translatePairs.map((p) =>
        p.id === action.id ? { ...p, translation: '', failed: false } : p,
      )
      const meetingLines = state.meetingLines.map((ln) =>
        ln.id === action.id ? { ...ln, translation: '', translateFailed: false } : ln,
      )
      return {
        ...state,
        translatePairs,
        meetingLines,
        translateBindId: state.translateBindId === action.id ? '' : state.translateBindId,
      }
    }
    case 'retry_translate': {
      const translatePairs = state.translatePairs.map((p) =>
        p.id === action.id ? { ...p, translation: '', to: state.translateTo, failed: false, passthrough: false } : p,
      )
      return { ...state, translatePairs, translateBindId: action.id }
    }
    case 'ask_start':
      return { ...state, busy: true, status: 'Asking…' }
    case 'seed_ask': {
      const turns = [...state.turns, { id: '__pending_ask__', q: action.text, a: '' }]
      return { ...state, turns, currentQ: action.text, busy: true, status: 'Asking…' }
    }
    case 'fail_ask': {
      const turns = state.turns.map((t) =>
        t.id === '__pending_ask__' && !t.a ? { ...t, a: action.text } : t,
      )
      return { ...state, turns, busy: false, status: action.text }
    }
    case 'fail_translate': {
      const translatePairs = state.translatePairs.map((p) =>
        p.id === action.id ? { ...p, failed: true } : p,
      )
      // A meeting line that gave up is marked so pump skips it (no resend loop).
      const meetingLines = state.meetingLines.map((ln) =>
        ln.id === action.id ? { ...ln, translateFailed: true } : ln,
      )
      return {
        ...state,
        translatePairs,
        meetingLines,
        translateBindId: state.translateBindId === action.id ? '' : state.translateBindId,
      }
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

// Script/language check for a translated line lives in translateGate.ts now.

function langTag(lang: PairLang): string {
  return TRANSLATE_LANGS.find((l) => l.id === lang)?.tag ?? lang.toUpperCase()
}

function engineSource(listenMic: boolean, systemMuted: boolean): AudioSource {
  if (systemMuted) return 'mic'
  return listenMic ? 'both' : 'system'
}

export default function App() {
  const phone = usePhoneChrome()
  const phoneRef = useRef(phone)
  phoneRef.current = phone
  const [state, dispatch] = useReducer(reducer, initial, applyDemoSeed)
  const demoScene = readDemoScene()
  const stateRef = useRef(state)
  stateRef.current = state
  const listenWanted = useRef(false)
  const [savePrompt, setSavePrompt] = useState(false)
  const [savePromptMode, setSavePromptMode] = useState<'discard' | 'cancel'>('discard')
  const [saveBannerOpen, setSaveBannerOpen] = useState(false)
  const [saveBook, setSaveBook] = useState<SaveBook>(emptySaveBook)
  const saveBookRef = useRef(saveBook)
  saveBookRef.current = saveBook
  const [historyKept, setHistoryKept] = useState(false)
  const historyKeptRef = useRef(false)
  const markHistoryKept = (kept: boolean) => {
    historyKeptRef.current = kept
    setHistoryKept(kept)
  }
  const pendingNewAfterSave = useRef(false)
  const pendingRestoreId = useRef<string | null>(null)
  const lastRestoredKeepId = useRef<string | null>(null)
  const offerSaveAfterMeetingStopRef = useRef<() => void>(() => undefined)
  const doClearRef = useRef<() => void>(() => undefined)
  const handleEngineKeepRef = useRef<(e: EngineEvent) => void>(() => undefined)
  // #36: a live session may show at most ONE Save UI. Set when the Save dialog is
  // first opened; gating the AUTO offers (Stop, save_prompt, reconnect Restore,
  // New-session leave) so the same session is never re-prompted. A user-initiated
  // Save (menu / phone button, a retry after a failed keep) bypasses it.
  const saveOfferedRef = useRef(false)
  const keepTimerRef = useRef(0)
  const keepEpochRef = useRef<{ liveId: string | null; generation: number } | null>(null)
  const pendingKeepRef = useRef<{ content: boolean; audio: boolean; waitNotes: boolean } | null>(null)
  const commitBook = (next: SaveBook) => {
    saveBookRef.current = next
    setSaveBook(next)
    saveOfferedRef.current = next.offered
  }
  const startOrResumeMeeting = (s: AppState) => {
    if (s.meetingStartedAt == null) {
      dispatch({ type: 'listen_new' })
      markHistoryKept(false)
      return
    }
    if (s.meetingEnded) {
      dispatch({ type: 'meeting_resume' })
      if (resumeResetsKept({ kept: historyKeptRef.current, hasContent: meetingHasSaveableContent(s) })) {
        markHistoryKept(false)
        commitBook({
          ...bumpGeneration(saveBookRef.current),
          status: 'undecided',
          offered: false,
        })
        setSaveBannerOpen(false)
      }
      return
    }
    dispatch({ type: 'meeting_clock', startedAt: Date.now() - s.meetingElapsedMs, elapsedMs: s.meetingElapsedMs })
  }
  // #36: pending (disconnected) session ids already offered for Restore, so a
  // reconnect never re-prompts the same unsaved session.
  const seenRestoreIds = useRef(new Set<string>())
  const watchAutoNotes = useRef(false)
  const autoReport = useRef(false)
  const recordHeard = useRef(false)
  const watchRestoreTried = useRef(false)
  const handleModeRef = useRef<(mode: WorkspaceMode, scene?: ListenScene) => void>(() => undefined)
  const [watchReportOpen, setWatchReportOpen] = useState(false)
  const [watchReportReveal, setWatchReportReveal] = useState(0)
  const showWatchReport = () => {
    setWatchReportOpen(true)
    setWatchReportReveal((n) => n + 1)
  }
  const startListen = (opts?: { fromWatch?: boolean }) => {
    if (!opts?.fromWatch) takePhoneMic()
    listenWanted.current = true
    // Starting a fresh listen abandons any pending recovery of a previously
    // disconnected meeting session — its prompt is dropped and the server
    // purges the pending row after 24h rather than letting it shadow this one.
    setSavePrompt(false)
    pendingRestoreId.current = null
    commitBook({ ...saveBookRef.current, offered: false })
    setSaveBannerOpen(false)
    seenRestoreIds.current.clear()
    if (!watchAutoNotes.current && !autoReport.current) {
      clearWatchReport()
      setWatchReportOpen(false)
    }
    const s = stateRef.current
    if (s.workspaceMode === 'meeting') stopSpeech()
    if (s.workspaceMode === 'translate' || s.translateOn) {
      unlockSpeech()
    }
    window.api.send({ type: 'start_listen' })
  }
  const stopListen = () => {
    listenWanted.current = false
    window.api.send({ type: 'stop_listen' })
  }
  const askedTranslate = useRef<Set<string>>(new Set())
  const inflightTranslate = useRef<string | null>(null)
  const translateRetries = useRef<Map<string, number>>(new Map())
  const translateFiles = useRef<Map<string, AttachPayload[]>>(new Map())
  const translateTimer = useRef(0)
  const pumpTranslateRef = useRef<() => void>(() => {})
  const generateNotesRef = useRef<() => void>(() => {})
  const exportAfterNotes = useRef(false)
  const keepAfterNotes = useRef<KeepAfterNotesJob | null>(null)
  const autoNotesTried = useRef(false)
  const tickRef = useRef(0)
  const [consent, setConsent] = useState<boolean | null>(demoScene ? true : null)
  const [ttsMode, setTtsMode] = useState<TtsMode>(readTtsMode)
  const [ttsVoice, setTtsVoice] = useState<TtsVoice>(readTtsVoice)
  const [speaking, setSpeaking] = useState(isSpeaking)
  const spokenTranslate = useRef<Set<string>>(new Set())
  const ttsVoiceRef = useRef(ttsVoice)
  ttsVoiceRef.current = ttsVoice
  const consentRef = useRef<boolean | null>(demoScene ? true : null)
  const [consentOpen, setConsentOpen] = useState(false)
  const pendingMic = useRef<(() => void) | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [railHover, setRailHover] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const studyMode = state.workspaceMode === 'interview'
  const inQa = studyMode && (
    composeOpen
    || state.busy
    || state.turns.length > 0
    || (Boolean(state.currentQ) && state.currentQ !== PLACEHOLDER)
  )
  const [historyOpen, setHistoryOpen] = useState(false)
  const [meetingSpeakersId, setMeetingSpeakersId] = useState<MeetingSpeakerId>(() => meetingSpeakerId())
  const [moreOpen, setMoreOpen] = useState(false)
  const restoreHistory = useCallback((session: HistorySession) => {
    const s = stateRef.current
    if (s.busy || s.capture !== 'off' || listenWanted.current) {
      dispatch({
        type: 'engine',
        ev: { type: 'status', text: 'Stop listening or wait for the answer before opening a saved session.' },
      })
      return
    }
    const payload = restoreFromSession(session)
    window.api.send({
      type: 'set_workspace',
      mode: payload.mode,
      scene: payload.scene,
      speakers_expected: speakersExpected(payload.scene, meetingSpeakerCount()),
    })
    dispatch({ type: 'restore_session', ...payload })
    markHistoryKept(true)
    setRailDismissed(false)
    setHistoryOpen(false)
    dispatch({
      type: 'engine',
      ev: { type: 'status', text: `Opened ${payload.scene} session` },
    })
  }, [])
  const [railDismissed, setRailDismissed] = useState(inQa)
  const wasInQa = useRef(inQa)
  const requestClearRef = useRef<() => void>(() => {})
  const handleRecordRef = useRef<() => void>(() => {})

  // After a disconnect, a meeting session that produced content but was never
  // saved is re-offered once. Query the server for it; if present, pop the
  // SavePrompt and remember which session id the Save/Don't-save must target.
  const checkPendingRestore = () => {
    void authApi<{ sessions: HistorySession[] }>('/api/account/history?pending=1')
      .then((out) => {
        const pending = (out.sessions || [])[0]
        if (!pending) return
        // #36 rule 4/5: never interrupt a live/paused view, never re-prompt the
        // same pending id on a reconnect, and never ask over a session that has
        // already had its one Save UI.
        const s = stateRef.current
        if (restoreShouldNotAsk({ listening: listenWanted.current, paused: s.capture === 'paused', hasContent: meetingHasSaveableContent(s) })) return
        if (!restoreIdOfferable(seenRestoreIds.current, pending.id)) return
        if (saveOfferedRef.current) return
        pendingRestoreId.current = pending.id
        commitBook(markOffered(saveBookRef.current))
        setSavePromptMode('discard')
        setSavePrompt(true)
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    if (inQa && !wasInQa.current) setRailDismissed(true)
    if (!inQa) setRailDismissed(false)
    wasInQa.current = inQa
  }, [inQa])

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

  useEffect(() => onSpeakingChange(setSpeaking), [])

  const guardMic = (fn: () => void) => {
    const running = sessionListening({ capture: stateRef.current.capture })
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

  useEffect(() => {
    if (!isNativeApp()) return
    const applyWatchMode = (raw?: string) => {
      const s = stateRef.current
      const next = watchShouldApplyMode(raw, s)
      if (!next) return
      handleModeRef.current(next.workspace, next.scene)
      stateRef.current = {
        ...stateRef.current,
        workspaceMode: next.workspace,
        listenScene: next.scene ?? (next.workspace === 'interview' ? 'interview' : stateRef.current.listenScene),
      }
    }
    const applyWatchMic = (raw?: string) => {
      const s = stateRef.current
      const mode = watchListenMode(raw) || watchStatusMode(s.workspaceMode, s.listenScene)
      if (watchStartShouldPreferWatchMic(mode)) setPreferWatchMic(true)
      else takePhoneMic()
    }
    return installWatchRemote({
      onStart: (mode) => {
        applyWatchMic(mode)
        const s = stateRef.current
        if (!watchListenControlShouldApplyMode({ action: 'start', paused: s.capture === 'paused', capture: s.capture })) {
          guardMic(() => startListen({ fromWatch: true }))
          return
        }
        applyWatchMode(mode)
        watchAutoNotes.current = true
        recordHeard.current = false
        watchRestoreTried.current = false
        clearWatchReport()
        setWatchReportOpen(false)
        const workspace = watchShouldApplyMode(mode, s)?.workspace ?? s.workspaceMode
        if (workspace === 'meeting' && (s.meetingEnded || s.meetingStartedAt == null)) {
          startOrResumeMeeting(s)
        }
        guardMic(() => startListen({ fromWatch: true }))
      },
      onRecord: (mode) => {
        applyWatchMic(mode)
        const s = stateRef.current
        if (!watchListenControlShouldApplyMode({ action: 'record', paused: s.capture === 'paused', capture: s.capture })) {
          if (s.capture === 'paused') {
            guardMic(() => startListen({ fromWatch: true }))
            return
          }
          if (sessionListening({ capture: s.capture })) {
            stopListen()
          }
          return
        }
        applyWatchMode(mode)
        watchAutoNotes.current = true
        autoReport.current = true
        recordHeard.current = false
        watchRestoreTried.current = false
        clearWatchReport()
        setWatchReportOpen(false)
        const workspace = watchShouldApplyMode(mode, s)?.workspace ?? s.workspaceMode
        if (workspace === 'meeting' && (s.meetingEnded || s.meetingStartedAt == null)) {
          startOrResumeMeeting(s)
        }
        guardMic(() => startListen({ fromWatch: true }))
      },
      onPause: () => {
        // Pause keeps the session alive (capture=paused) instead of tearing it
        // down; resume_listen brings it back without a fresh start.
        window.api.send({ type: 'pause_listen' })
        const s = stateRef.current
        if (s.workspaceMode === 'meeting' && s.meetingStartedAt != null && !s.meetingEnded) {
          dispatch({ type: 'meeting_clock', startedAt: s.meetingStartedAt, elapsedMs: Date.now() - s.meetingStartedAt })
        }
      },
      onResume: () => {
        applyWatchMic()
        const s = stateRef.current
        if (s.workspaceMode === 'meeting' && s.meetingStartedAt != null && !s.meetingEnded) {
          dispatch({ type: 'meeting_clock', startedAt: Date.now() - s.meetingElapsedMs, elapsedMs: s.meetingElapsedMs })
        }
        window.api.send({ type: 'resume_listen' })
      },
      onStop: () => {
        stopListen()
        if (stateRef.current.workspaceMode === 'meeting') {
          dispatch({ type: 'meeting_ended' })
          if (watchStopShouldOpenPhoneSave()) {
            queueMicrotask(() => offerSaveAfterMeetingStopRef.current())
          }
        }
      },
      onSave: () => {
        window.api.send(watchSaveCommand())
        markHistoryKept(true)
      },
      onDiscard: () => {
        window.api.send(watchDiscardCommand())
        markHistoryKept(false)
      },
      onSpeak: () => {
        const s = stateRef.current
        const fromPairs = [...s.translatePairs].reverse().find((p) => (p.translation || '').trim())
        const fromLines = [...s.meetingLines].reverse().find((ln) => (ln.translation || '').trim())
        const text = (fromPairs?.translation || fromLines?.translation || '').trim()
        if (!text) return
        void speakTranslation(text, ttsVoiceRef.current, 'watch').catch((err) => {
          dispatch({
            type: 'engine',
            ev: { type: 'status', text: err instanceof Error ? err.message : 'Could not speak translation' },
          })
        })
      },
      onTtsLive: () => {
        // Watch no longer offers Auto. Leftover tts_live must not start speaker playback.
      },
      onTtsTap: () => {
        setTtsMode('tap')
        writeTtsMode('tap')
        stopSpeech()
      },
      onTtsVoice: (voice) => {
        setTtsVoice(voice)
        writeTtsVoice(voice)
      },
    })
  }, [])

  useEffect(() => {
    if (!isNativeApp()) return
    const face = buildWatchFace({
      capture: state.capture,
      consentOpen,
      notesAskId: state.notesAskId,
      notesRaw: state.notesRaw,
      partial: state.partial,
      workspaceMode: state.workspaceMode,
      translateOn: state.translateOn,
      translatePairs: state.translatePairs,
      meetingLines: state.meetingLines,
      turns: state.turns,
    })
    const timer = window.setTimeout(() => {
      pushWatchStatus({
        capture: state.capture,
        hint: face.hint,
        original: face.original,
        translation: face.translation,
        previous: face.previous,
        history: face.history,
        mode: watchStatusMode(state.workspaceMode, state.listenScene),
        langPair: watchLangPair(state.translateTo),
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [
    consentOpen,
    state.capture,
    state.meetingLines,
    state.notesAskId,
    state.notesRaw,
    state.partial,
    state.translateOn,
    state.translatePairs,
    state.turns,
    state.workspaceMode,
    state.listenScene,
    state.translateTo,
  ])

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

  // (Re)arm the 25s translate timeout. Called on every chunk of the current
  // ask so a slow-but-alive stream doesn't time out mid-answer; and on the
  // timeout path we cancel the server generation first so the retry below
  // doesn't queue a duplicate behind a still-running stream.
  const armTranslateTimeout = (id: string | null) => {
    clearTranslateTimer()
    if (!id) return
    translateTimer.current = window.setTimeout(() => {
      if (inflightTranslate.current !== id) return
      window.api.send({ type: 'cancel_generate' })
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
  }

  // 发起新的生成（摘要/笔记/提问）前，取消在途翻译并清掉半截译文。
  // 否则旧翻译的 chunk 会按 translateBindId / '__pending__' 路由进新内容里（卡片/笔记被污染）。
  const killInflightTranslation = useCallback(() => {
    const s = stateRef.current
    const stuck = inflightTranslate.current || s.translateBindId
    if (!stuck) return
    window.api.send({ type: 'cancel_generate' })
    releaseTranslateGate(stuck)
    translateRetries.current.delete(stuck)
    askedTranslate.current.delete(stuck)
    dispatch({ type: 'clear_translation', id: stuck })
  }, [])

  useEffect(() => {
    const api = window.api
    const syncWorkspace = () => {
      const s = stateRef.current
      api.send({ type: 'set_translate_from', language: s.translateFrom === 'auto' ? null : s.translateFrom })
      api.send({ type: 'set_translate_to', lang: s.translateTo })
      const scene = s.workspaceMode === 'interview' ? 'interview' : s.listenScene
      api.send({ type: 'set_workspace', mode: s.workspaceMode, scene, speakers_expected: speakersExpected(scene, meetingSpeakerCount()) })
      if (s.workspaceMode !== 'translate') {
        api.send({ type: 'set_lang', language: s.lang === 'auto' ? null : s.lang })
      }
    }
    const offEvent = api.onEvent((e) => {
      if (e.type === 'ready') {
        syncWorkspace()
        checkPendingRestore()
        if (listenWanted.current) {
          queueMicrotask(() => api.send({ type: 'start_listen' }))
        }
      }
      // Every chunk of the current translate ask re-arms the 25s timeout, so a
      // slow-but-alive stream doesn't time out mid-answer and double-fire.
      if (e.type === 'chunk' && e.id && e.id === stateRef.current.translateAskId && inflightTranslate.current) {
        armTranslateTimeout(inflightTranslate.current)
      }
      if (shouldReleaseListen(e)) {
        listenWanted.current = false
      }
      if (
        e.type === 'save_prompt'
        || e.type === 'history_kept'
        || e.type === 'history_keep_failed'
        || e.type === 'disconnected'
      ) {
        handleEngineKeepRef.current(e)
      }
      const translateAskBefore = stateRef.current.translateAskId
      dispatch({ type: 'engine', ev: e })
      if (e.type === 'question' && stateRef.current.workspaceMode === 'meeting' && stateRef.current.translateOn) {
        const text = e.text ?? ''
        if (!isTranslatePrompt(text) && !isCatchPrompt(text) && !isNotesPrompt(text)) {
          queueMicrotask(() => pumpTranslateRef.current())
        }
      }
      if (e.type === 'line_update' && stateRef.current.workspaceMode === 'meeting') {
        // The source changed (extended); the old translation for this line is now
        // stale. Clear its ask/retry and let pump re-pick it under the new rev.
        askedTranslate.current.delete(e.id)
        translateRetries.current.delete(e.id)
        queueMicrotask(() => pumpTranslateRef.current())
      }
      if (e.type === 'question' && stateRef.current.workspaceMode === 'translate') {
        const text = e.text ?? ''
        const s = stateRef.current
        if (!isTranslatePrompt(text) && s.translateFrom !== 'auto') {
          const heard = parseHeardLang(e.language, text)
          if (!matchesLockedFrom(text, s.translateFrom, heard)) return
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
      if (!translateDoneBelongsToAsk(translateAskBefore, e.id)) {
        if (!inflightTranslate.current) queueMicrotask(() => pumpTranslateRef.current())
        return
      }
      const id = inflightTranslate.current
      clearTranslateTimer()
      inflightTranslate.current = null
      queueMicrotask(() => {
        if (id) {
          const s = stateRef.current
          const line = s.meetingLines.find((ln) => ln.id === id)
          // A meeting line that was extended after this translation was asked has
          // a bumped rev: the done (and its streamed translation) is stale. Clear
          // the half-sentence result and re-ask for the extended line. Do NOT
          // cancel_generate (that would leave the stream waiting 25s) and do NOT
          // count a retry — the source legitimately changed, not the model.
          const stale = s.workspaceMode === 'meeting' && staleTranslateDone(id, s.translateBindRev, line)
          if (stale) {
            askedTranslate.current.delete(id)
            translateRetries.current.delete(id)
            dispatch({ type: 'clear_translation', id })
            dispatch({ type: 'release_translate' })
            pumpTranslateRef.current()
            return
          }
          const row = s.translatePairs.find((p) => p.id === id)
          const translated = ((s.workspaceMode === 'translate' ? row?.translation : line?.translation) || '').trim()
          const retries = (translateRetries.current.get(id) || 0) + 1
          const outcome = translateDoneDecision({
            ok: e.ok,
            translated: Boolean(translated),
            wrongScript: Boolean(translated) && wrongScriptForTarget(translated, s.translateTo),
            retries,
          })
          if (outcome === 'accept') {
            if (translated) translateRetries.current.delete(id)
            dispatch({ type: 'release_translate' })
          } else if (outcome === 'retry') {
            translateRetries.current.set(id, retries)
            askedTranslate.current.delete(id)
            dispatch({ type: 'clear_translation', id })
            dispatch({ type: 'release_translate' })
          } else {
            // fail: for a translate row it marks failed; for a meeting line it
            // marks translateFailed so pump will not re-send it in a loop. Don't
            // delete asked either — the give-up flag is what stops the re-pick.
            dispatch({ type: 'fail_translate', id })
            dispatch({ type: 'release_translate' })
          }
        }
        pumpTranslateRef.current()
      })
    })
    const offShortcut = api.onShortcut((k) => {
      const mode = stateRef.current.workspaceMode
      if (k === 'f2') handleRecordRef.current()
      else if (k === 'f3') {
        const running = sessionListening({ capture: stateRef.current.capture })
        if (running) stopListen()
        else guardMic(startListen)
      }
      else if (k === 'f4') requestClearRef.current()
      else if (!isWeb && k === 'f8' && mode === 'interview') {
        const v = stateRef.current.view
        dispatch({ type: 'view', view: v === 'workspace' ? 'fullscreen' : 'workspace' })
      }
      else if (!isWeb && k === 'f9' && mode === 'interview') {
        const next = !stateRef.current.stealth
        api.setStealth(next)
        dispatch({ type: 'stealth', on: next })
        dispatch({ type: 'engine', ev: { type: 'status', text: next ? 'Stealth on — hidden from screen capture' : 'Stealth off' } })
      }
    })
    api.getConfig().then((cfg) => {
      dispatch({ type: 'config', cfg })
    })
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
        } else if (k === 'c' && !e.ctrlKey && !e.metaKey && !window.getSelection()?.toString().trim()) {
          copyLatest()
        }
        return
      }
      if (k === 'a') {
        const running = sessionListening({ capture: stateRef.current.capture })
        if (running) stopListen()
        else guardMic(startListen)
      }
      else if (k === 'c' && !e.ctrlKey && !e.metaKey && !window.getSelection()?.toString().trim()) copyLatest()
      else if (k === 'x') requestClearRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyLatest])

  const clearKeepTimer = () => {
    if (keepTimerRef.current) {
      window.clearTimeout(keepTimerRef.current)
      keepTimerRef.current = 0
    }
  }

  const failKeep = (reason: 'timeout' | 'error' | 'disconnect') => {
    const next = applyKeepFailed(saveBookRef.current, reason)
    if (next === saveBookRef.current) return
    commitBook(next)
    pendingKeepRef.current = null
    keepAfterNotes.current = null
    clearKeepTimer()
    if (phoneRef.current && next.offered) setSaveBannerOpen(true)
    dispatch({ type: 'engine', ev: { type: 'status', text: IPHONE_COPY.saveFailed } })
  }

  const sendKeepNow = (opts: { content: boolean; audio: boolean }) => {
    window.api.send({ type: 'keep_history', content: opts.content, audio: opts.audio })
    clearKeepTimer()
    keepTimerRef.current = window.setTimeout(() => failKeep('timeout'), KEEP_ACK_TIMEOUT_MS)
  }

  const flushPendingKeep = () => {
    const pending = pendingKeepRef.current
    const book = saveBookRef.current
    if (!pending || !book.liveId || book.status !== 'saving') return
    pendingKeepRef.current = null
    if (pending.waitNotes && keepShouldWaitForNotes(stateRef.current.notesAskId)) {
      keepAfterNotes.current = {
        content: pending.content,
        audio: pending.audio,
        liveId: book.liveId,
        generation: book.generation,
      }
      return
    }
    sendKeepNow(pending)
  }

  const bindLiveFromEngine = (id?: string) => {
    if (!id) return
    commitBook(bindLiveId(saveBookRef.current, id))
    if (keepEpochRef.current && !keepEpochRef.current.liveId) {
      keepEpochRef.current = { ...keepEpochRef.current, liveId: id }
    }
    flushPendingKeep()
  }

  const offerSaveUi = () => {
    const s = stateRef.current
    if (!sessionShouldOpenSavePrompt({
      workspaceMode: s.workspaceMode,
      kept: historyKeptRef.current,
      paused: s.capture === 'paused',
    })) return
    const surface = savePromptSurface({
      phone: phoneRef.current,
      workspaceMode: s.workspaceMode,
      kept: historyKeptRef.current,
      offered: saveBookRef.current.offered,
      hasContent: meetingHasSaveableContent(s),
    })
    if (surface === 'none') return
    commitBook(markOffered(saveBookRef.current))
    if (surface === 'banner') {
      setSaveBannerOpen(true)
      return
    }
    setSavePromptMode('discard')
    setSavePrompt(true)
  }

  const saveLiveSession = (opts?: { content?: boolean; audio?: boolean; fromPrompt?: boolean }) => {
    if (historyKeptRef.current) {
      setHistoryOpen(true)
      return
    }
    if (!isNativeApp() && !opts?.fromPrompt) {
      setSavePromptMode('cancel')
      setSavePrompt(true)
      return
    }
    const content = opts?.content !== false
    const audio = opts?.audio !== false
    const book = beginSave(saveBookRef.current, saveBookRef.current.liveId || '')
    commitBook(book)
    keepEpochRef.current = { liveId: book.liveId, generation: book.generation }
    if (phoneRef.current) setSaveBannerOpen(true)
    const waitNotes = keepShouldWaitForNotes(stateRef.current.notesAskId)
    if (!book.liveId) {
      pendingKeepRef.current = { content, audio, waitNotes }
      clearKeepTimer()
      keepTimerRef.current = window.setTimeout(() => failKeep('timeout'), KEEP_ACK_TIMEOUT_MS)
      return
    }
    if (waitNotes) {
      keepAfterNotes.current = { content, audio, liveId: book.liveId, generation: book.generation }
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Saving after notes finish…' } })
      return
    }
    sendKeepNow({ content, audio })
  }

  handleEngineKeepRef.current = (e) => {
    if (e.type === 'save_prompt') {
      bindLiveFromEngine(e.id)
      if (watchAutoNotes.current) {
        if (watchStopShouldAutoKeepHistory(watchAutoNotes.current)) {
          window.api.send(watchSaveCommand())
          markHistoryKept(true)
        }
        return
      }
      offerSaveUi()
      return
    }
    if (e.type === 'disconnected') {
      failKeep('disconnect')
      return
    }
    if (e.type === 'history_keep_failed') {
      const book = saveBookRef.current
      if (e.id && book.liveId && e.id !== book.liveId) return
      failKeep('error')
      return
    }
    if (e.type !== 'history_kept') return
    if (!shouldMarkKeptOnAck(e.id, lastRestoredKeepId.current)) {
      lastRestoredKeepId.current = null
      return
    }
    const book = saveBookRef.current
    const epoch = keepEpochRef.current
    const { book: next, action } = applyKeepAck(
      book,
      e.id,
      book.liveId,
      epoch?.generation ?? book.generation,
    )
    if (next.status === 'saved' && next !== book) {
      markHistoryKept(true)
      commitBook(next)
      clearKeepTimer()
      pendingKeepRef.current = null
      keepAfterNotes.current = null
      keepEpochRef.current = null
      setSaveBannerOpen(false)
      if (action === 'new') {
        pendingNewAfterSave.current = false
        doClearRef.current()
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Saved · new session' } })
      }
      return
    }
  }

  const doClear = useCallback(() => {
    spokenTranslate.current.clear()
    stopSpeech()
    askedTranslate.current.clear()
    window.api.send({ type: 'cancel_generate' })
    releaseTranslateGate()
    translateRetries.current.clear()
    window.api.send({ type: 'clear' })
    dispatch({ type: 'clear' })
    setClearOpen(false)
    markHistoryKept(false)
    pendingNewAfterSave.current = false
    pendingKeepRef.current = null
    keepAfterNotes.current = null
    keepEpochRef.current = null
    clearKeepTimer()
    setSaveBannerOpen(false)
    commitBook({
      ...bumpGeneration(saveBookRef.current),
      liveId: null,
      status: 'undecided',
      offered: false,
      pendingAfterSave: 'none',
    })
    seenRestoreIds.current.clear()
  }, [])
  doClearRef.current = doClear

  const offerSaveAfterMeetingStop = () => {
    const s = stateRef.current
    if (s.workspaceMode !== 'meeting' || historyKeptRef.current) return
    offerSaveUi()
  }
  offerSaveAfterMeetingStopRef.current = offerSaveAfterMeetingStop

  const handleNewSession = useCallback(() => {
    const s = stateRef.current
    if (s.busy || s.capture !== 'off' || listenWanted.current) {
      dispatch({
        type: 'engine',
        ev: { type: 'status', text: 'Stop listening or wait for the answer before starting a new session.' },
      })
      return
    }
    if (sessionShouldOfferSave({
      workspaceMode: s.workspaceMode,
      ended: s.meetingEnded,
      kept: historyKept,
      hasContent: meetingHasSaveableContent(s),
      listening: false,
    })) {
      pendingNewAfterSave.current = true
      commitBook({ ...markOffered(saveBookRef.current), pendingAfterSave: 'new' })
      setSaveBannerOpen(false)
      setSavePromptMode('discard')
      setSavePrompt(true)
      return
    }
    doClear()
    dispatch({ type: 'engine', ev: { type: 'status', text: 'New session' } })
  }, [doClear, historyKept])

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
  const parkAttaches = async (files?: AttachPayload[]) => {
    if (!files?.length) return undefined
    const out = await authApi<{ id: string }>('/api/attach/extract', {
      method: 'POST',
      body: JSON.stringify({ files }),
    })
    return out.id
  }

  const handleAsk = useCallback((text: string, files?: AttachPayload[]) => {
    const label = text.trim() || (files?.length ? `Please review: ${files.map((f) => f.name).join(', ')}` : '')
    dispatch({ type: 'seed_ask', text: label })
    void (async () => {
      try {
        const attach_id = await parkAttaches(files)
        window.api.send({ type: 'ask', text, attach_id })
      } catch (ex) {
        dispatch({
          type: 'fail_ask',
          text: ex instanceof Error ? ex.message : 'Could not send the file',
        })
      }
    })()
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
    const s = stateRef.current
    if (listenSettingsBlocked({ capture: s.capture, workspaceMode: s.workspaceMode })) {
      dispatch({ type: 'engine', ev: { type: 'status', text: IPHONE_COPY.settingsLocked } })
      return
    }
    window.api.send({ type: 'set_lang', language: lang === 'auto' ? null : lang })
    dispatch({ type: 'lang', lang })
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text:
          lang === 'auto'
            ? 'Speech recognition · Auto · follows the language you speak'
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
      // Target changed (from↔to swap): re-arm give-up meeting lines the same
      // way the target dropdown does.
      for (const ln of s.meetingLines.filter((ln) => ln.translateFailed)) {
        askedTranslate.current.delete(ln.id)
        translateRetries.current.delete(ln.id)
      }
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

  const handleMode = useCallback((mode: WorkspaceMode, scene?: ListenScene) => {
    const s = stateRef.current
    const nextScene = scene ?? (mode === 'interview' ? 'interview' : s.listenScene)
    if (mode === s.workspaceMode && nextScene === s.listenScene) return
    if (!canSwitchWorkspace({
      listening: sessionListening({ capture: s.capture }),
      paused: s.capture === 'paused',
    })) {
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Stop listening first' } })
      return
    }
    if (s.stealth && mode !== 'interview') {
      window.api.setStealth(false)
      dispatch({ type: 'stealth', on: false })
    }
    if (s.view !== 'workspace') dispatch({ type: 'view', view: 'workspace' })
    if (nextScene !== s.listenScene) dispatch({ type: 'listen_scene', scene: nextScene })
    if (mode === 'translate') {
      window.api.send({ type: 'cancel_generate' })
      window.api.send({ type: 'set_translate_from', language: s.translateFrom === 'auto' ? null : s.translateFrom })
      window.api.send({ type: 'set_translate_to', lang: s.translateTo })
    } else {
      window.api.send({ type: 'set_lang', language: s.lang === 'auto' ? null : s.lang })
    }
    window.api.send({ type: 'set_workspace', mode, scene: nextScene, speakers_expected: speakersExpected(nextScene, meetingSpeakerCount()) })
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
              ? 'Mode · Live Q&A'
              : nextScene === 'lecture'
                ? 'Mode · Lecture'
                : 'Mode · AI Listening Assistant',
      },
    })
  }, [])
  handleModeRef.current = handleMode

  const handlePrimary = useCallback(() => {
    const s = stateRef.current
    const live = sessionListening({ capture: s.capture })
    if (s.capture === 'paused') {
      // Paused resumes, not a fresh start: start_listen returns early without
      // emitting when the listener is still alive, so capture would stay
      // 'paused'. resume_listen emits the phase that flips it back.
      window.api.send({ type: 'resume_listen' })
      return
    }
    if (s.workspaceMode === 'interview') {
      if (s.capture === 'recording') return
      if (live) stopListen()
      else guardMic(startListen)
      return
    }
    if (s.workspaceMode === 'meeting') {
      if (live) {
        autoReport.current = true
        recordHeard.current = true
        stopListen()
        dispatch({ type: 'meeting_ended' })
        dispatch({ type: 'engine', ev: { type: 'status', text: 'Listening stopped · writing notes' } })
        queueMicrotask(() => offerSaveAfterMeetingStopRef.current())
        return
      }
      startOrResumeMeeting(s)
      guardMic(startListen)
      return
    }
    if (s.capture === 'recording') return
    if (live) {
      stopListen()
      return
    }
    guardMic(() => {
      window.api.send({ type: 'set_workspace', mode: 'translate', scene: stateRef.current.listenScene })
      window.api.send({ type: 'set_translate_from', language: s.translateFrom === 'auto' ? null : s.translateFrom })
      window.api.send({ type: 'set_translate_to', lang: s.translateTo })
      startListen()
    })
  }, [])

  const handleStop = useCallback(() => {
    const s = stateRef.current
    if (sessionListening({ capture: s.capture })) {
      handlePrimary()
      return
    }
    if (s.workspaceMode === 'meeting' && s.meetingStartedAt != null && !s.meetingEnded) {
      autoReport.current = true
      recordHeard.current = true
      if (stopShouldReleaseListener(s.capture)) stopListen()
      dispatch({ type: 'meeting_ended' })
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Listening stopped · writing notes' } })
      queueMicrotask(() => offerSaveAfterMeetingStopRef.current())
    }
  }, [handlePrimary])

  const handleRecord = useCallback(() => {
    const s = stateRef.current
    if (s.workspaceMode === 'translate') {
      guardMic(() => window.api.send({ type: 'manual' }))
      return
    }
    if (s.workspaceMode !== 'meeting') return
    if (s.capture === 'paused') {
      autoReport.current = true
      recordHeard.current = true
      stopListen()
      dispatch({ type: 'meeting_ended' })
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Recording stopped · writing report' } })
      queueMicrotask(() => offerSaveAfterMeetingStopRef.current())
      return
    }
    if (sessionListening({ capture: s.capture })) {
      autoReport.current = true
      recordHeard.current = true
      stopListen()
      dispatch({ type: 'meeting_ended' })
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Recording stopped · writing report' } })
      queueMicrotask(() => offerSaveAfterMeetingStopRef.current())
      return
    }
    autoReport.current = true
    recordHeard.current = false
    startOrResumeMeeting(s)
    guardMic(startListen)
    dispatch({ type: 'engine', ev: { type: 'status', text: 'Recording · report after stop' } })
  }, [])
  handleRecordRef.current = handleRecord

  const handlePause = useCallback(() => {
    const s = stateRef.current
    if (sessionListening({ capture: s.capture })) {
      if (s.workspaceMode === 'meeting' && s.meetingStartedAt != null && !s.meetingEnded) {
        dispatch({ type: 'meeting_clock', startedAt: s.meetingStartedAt, elapsedMs: Date.now() - s.meetingStartedAt })
      }
      window.api.send({ type: 'pause_listen' })
      dispatch({ type: 'engine', ev: { type: 'status', text: 'Paused · resume when ready' } })
    }
  }, [])

  const handleResume = useCallback(() => {
    window.api.send({ type: 'resume_listen' })
    dispatch({ type: 'engine', ev: { type: 'status', text: 'Listening resumed' } })
  }, [])

  const handleMark = useCallback(() => {
    dispatch({ type: 'mark_action' })
  }, [])

  const handleTranslateTo = useCallback((lang: Lang) => {
    const s = stateRef.current
    if (listenSettingsBlocked({ capture: s.capture, workspaceMode: s.workspaceMode })) {
      dispatch({ type: 'engine', ev: { type: 'status', text: IPHONE_COPY.settingsLocked } })
      return
    }
    const keepExisting = s.workspaceMode !== 'translate' && (s.meetingEnded || s.meetingLines.length > 0)
    if (lang === 'auto') {
      if (s.notesLang === 'auto') return
      persistNotesLang('auto')
      // 只解锁 STT 语言当它本来就是 auto；用户显式锁定的识别语言不被悄悄重置
      if (s.lang === 'auto') {
        window.api.send({ type: 'set_lang', language: null })
      }
      // Auto notes only: the translation target stays put (decoupled from notes).
      dispatch({ type: 'notes_lang', lang: 'auto' })
      dispatch({
        type: 'engine',
        ev: { type: 'status', text: 'Auto · notes follow the language you speak' },
      })
      return
    }
    // Specific language. In the Meeting / Lecture notes dropdown the one control
    // drives both the notes language and the translation target; in the Translate
    // workspace it changes only the target.
    const meeting = s.workspaceMode !== 'translate'
    if (lang === s.translateTo && (meeting ? s.notesLang === lang : true)) return
    persistTranslatePair(s.translateFrom, lang)
    if (meeting) persistNotesLang(lang)
    const stuck = inflightTranslate.current
    if (!keepExisting) window.api.send({ type: 'cancel_generate' })
    window.api.send({ type: 'set_translate_to', lang })
    if (!keepExisting) releaseTranslateGate(stuck)
    // A meeting line that gave up (translateFailed) becomes eligible again under
    // the new target — clear its give-up refs so pump re-picks it (the reducer
    // resets the flag on translate_to). After End, leave existing lines alone.
    if (!keepExisting) {
      for (const ln of s.meetingLines.filter((ln) => ln.translateFailed)) {
        askedTranslate.current.delete(ln.id)
        translateRetries.current.delete(ln.id)
      }
    }
    for (const action of notesLangActions(s.workspaceMode, lang)) dispatch(action as never)
    dispatch({
      type: 'engine',
      ev: {
        type: 'status',
        text: meeting
          ? `Notes language · ${targetName(lang)}`
          : s.translateFrom !== 'auto' && s.translateFrom === lang
            ? `Translate to ${targetName(lang)} · same as From`
            : `Translate to ${targetName(lang)}`,
      },
    })
    if (!keepExisting) queueMicrotask(() => pumpTranslateRef.current())
  }, [])

  const handleMeetingSpeakers = useCallback((id: MeetingSpeakerId) => {
    const locked = stateRef.current
    if (listenSettingsBlocked({ capture: locked.capture, workspaceMode: locked.workspaceMode })) {
      dispatch({ type: 'engine', ev: { type: 'status', text: IPHONE_COPY.settingsLocked } })
      return
    }
    setMeetingSpeaker(id)
    setMeetingSpeakersId(id)
    const s = stateRef.current
    const scene = s.workspaceMode === 'interview' ? 'interview' : s.listenScene
    const count = MEETING_SPEAKER_OPTIONS.find((o) => o.id === id)?.count ?? 2
    window.api.send({ type: 'set_workspace', mode: s.workspaceMode, scene, speakers_expected: speakersExpected(scene, count) })
    dispatch({
      type: 'engine',
      ev: { type: 'status', text: 'Switching the number of speakers reconnects for a few seconds.' },
    })
  }, [])

  const askTranslate = useCallback((text: string, pairId?: string) => {
    if (inflightTranslate.current) return
    const s = stateRef.current
    const id = pairId || `cap-${Date.now()}`
    const pair = pairId ? s.translatePairs.find((p) => p.id === pairId) : undefined
    // Typed input (id 'typed-…') has no STT from-tag, so the glyph check would
    // misread an unaccented Latin line as English and passthrough it (shown as
    // the source text twice + 'Same lang'). The user typing explicitly wants a
    // translation, so never passthrough typed input. Only a spoken pair (which
    // carries the STT from-tag) may passthrough.
    const typed = String(pairId || '').startsWith('typed-')
    // A meeting line has no translate pair, so its STT lang tag must be passed
    // through — otherwise fromTag is always undefined and every English line in
    // an English-target + Bilingual meeting hits the model. Typed pairs keep the
    // no-passthrough rule.
    const fromTag =
      s.workspaceMode === 'meeting' ? s.meetingLines.find((ln) => ln.id === id)?.lang : pair?.from
    const sameLang = !typed && translateShouldPassthrough(text, s.translateTo, fromTag)
    if (sameLang) {
      askedTranslate.current.add(id)
      translateRetries.current.delete(id)
      dispatch({ type: 'fill_translate', id, translation: text, passthrough: true })
      queueMicrotask(() => pumpTranslateRef.current())
      return
    }
    const target = targetName(s.translateTo)
    const sourceHint =
      s.workspaceMode === 'translate'
        ? s.translateFrom !== 'auto'
          ? s.translateFrom
          : s.heardLang
        : s.lang !== 'auto'
          ? s.lang
          : s.heardLang
    const prev =
      s.workspaceMode === 'meeting'
        ? s.meetingLines.filter((ln) => ln.id !== id && ln.text.trim()).slice(-6).map((ln) => ln.text)
        : s.translatePairs.filter((p) => p.id !== id && p.original.trim() && !isTranslatePrompt(p.original)).slice(-6).map((p) => p.original)
    const context = prev.length
      ? `Previous lines (context only, do not translate):\n${prev.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n\n`
      : ''
    const sourceLine = sourceHint ? `Source language: ${targetName(sourceHint)}.\n` : ''
    inflightTranslate.current = id
    askedTranslate.current.add(id)
    dispatch({ type: 'bind_translate', id, rev: s.workspaceMode === 'meeting' ? (s.meetingLines.find((ln) => ln.id === id)?.rev ?? 0) : 0 })
    window.api.send({
      type: 'ask',
      mode: 'translate',
      text: `[NOD_TRANSLATE:${id}]\n${TRANSLATE_PREFIX}${target}. ${sourceLine}${context}Translate only this line:\n${text}`,
      files: translateFiles.current.get(id),
    })
    translateFiles.current.delete(id)
    armTranslateTimeout(id)
  }, [])

  const pumpTranslate = useCallback(() => {
    const s = stateRef.current
    if (inflightTranslate.current) return
    if (s.workspaceMode === 'meeting' && s.translateOn) {
      // 最新的未翻译、未放弃、未被 asked 的行优先（实时字幕语义：先出当前句子，
      // 停顿期间回填旧行）。translateFailed 行被跳过，避免对坏模型的重发死循环。
      const next = nextMeetingLineToTranslate(s.meetingLines, askedTranslate.current)
      if (next) {
        askTranslate(next.text, next.id)
        return
      }
      return
    }
    if (s.workspaceMode !== 'translate') return
    for (let i = s.translatePairs.length - 1; i >= 0; i--) {
      const p = s.translatePairs[i]
      if (!p.translation && !p.failed && !askedTranslate.current.has(p.id) && !isTranslatePrompt(p.original)) {
        askTranslate(p.original, p.id)
        return
      }
    }
  }, [askTranslate])
  pumpTranslateRef.current = pumpTranslate

  useEffect(() => {
    const liveOn = ttsMode === 'live' && listenSessionShouldAutoSpeak(state.workspaceMode)
    if (!liveOn) {
      if (state.workspaceMode !== 'translate') stopSpeech()
      return
    }
    const next = nextLiveUtterances({
      live: true,
      workspaceMode: state.workspaceMode,
      translateOn: state.translateOn,
      bindId: state.translateBindId,
      spoken: spokenTranslate.current,
      pairs: state.translatePairs,
      lines: state.meetingLines,
    })
    for (const item of next) {
      spokenTranslate.current.add(item.id)
      void speakTranslation(item.text, ttsVoice).catch((err) => {
        spokenTranslate.current.delete(item.id)
        dispatch({
          type: 'engine',
          ev: { type: 'status', text: err instanceof Error ? err.message : 'Could not speak translation' },
        })
      })
    }
  }, [state.translatePairs, state.meetingLines, state.translateBindId, state.workspaceMode, state.translateOn, ttsMode, ttsVoice])

  // Stable identity so memoised transcript rows are not invalidated on every
  // parent render — with thousands of lines that dominates the frame budget.
  const handleRenameSpeaker = useCallback((id: string, name: string) => {
    dispatch({ type: 'rename_speaker', id, name })
  }, [])

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

  const generateNotes = useCallback(() => {
    const s = stateRef.current
    if (!s.meetingLines.length) {
      dispatch({ type: 'engine', ev: { type: 'status', text: 'No transcript to note yet.' } })
      return
    }
    killInflightTranslation()
    dispatch({ type: 'expect_notes' })
    const cap = capTranscript(s.meetingLines)
    window.api.send({ type: 'ask', text: notesPrompt(s.listenScene, cap.lines, s.notesLang, s.translateOn, s.speakerNames, cap), mode: 'notes' })
    if (cap.dropped > 0) {
      dispatch({
        type: 'engine',
        ev: { type: 'status', text: `Notes cover ${cap.lines.length}/${s.meetingLines.length} lines (from ${cap.fromTs})` },
      })
    }
  }, [])
  generateNotesRef.current = generateNotes

  useEffect(() => {
    const fromWatch = isNativeApp() && watchAutoNotes.current
    const flagged = fromWatch || autoReport.current
    if (flagged && (state.capture !== 'off' || state.engine !== 'idle')) {
      recordHeard.current = true
    }
    const next = shouldGenerateAutoReport({
      flagged,
      heardListen: recordHeard.current,
      capture: state.capture,
      engine: state.engine,
      workspaceMode: state.workspaceMode,
      busy: state.busy,
      lineCount: state.meetingLines.length,
    })
    if (next === 'wait') return
    watchAutoNotes.current = false
    autoReport.current = false
    recordHeard.current = false
    if (next === 'skip') return
    generateNotesRef.current()
    showWatchReport()
    if (!fromWatch) return
    const snap = snapshotFromWorkspace({
      mode: state.workspaceMode,
      scene: state.listenScene,
      notes: state.notesRaw,
      lines: state.meetingLines,
    })
    if (!snap) return
    markWatchReport()
    writeWatchReportSnapshot(snap)
  }, [state.busy, state.meetingLines.length, state.capture, state.engine, state.workspaceMode])

  useEffect(() => {
    if (!isNativeApp() || !readWatchReport()) return
    const snap = snapshotFromWorkspace({
      mode: state.workspaceMode,
      scene: state.listenScene,
      notes: state.notesRaw,
      lines: state.meetingLines,
    })
    if (snap) writeWatchReportSnapshot(snap)
  }, [state.listenScene, state.meetingLines, state.notesRaw, state.workspaceMode])

  useEffect(() => {
    if (!isNativeApp()) return
    const mark = readWatchReport()
    if (!mark) return
    showWatchReport()
    const s = stateRef.current
    if (
      !shouldRestoreWatchReport({
        mark,
        listening: s.capture !== 'off' || listenWanted.current,
        busy: s.busy,
        hasWorkspace: s.meetingLines.length > 0 || Boolean(s.notesRaw.trim()),
      })
    ) {
      return
    }
    if (watchRestoreTried.current) return
    watchRestoreTried.current = true
    const snap = readWatchReportSnapshot()
    if (snap && (snap.notes.trim() || snap.lines.length)) {
      restoreHistory({
        id: 'watch-report',
        mode: snap.mode,
        scene: snap.scene,
        title: 'Watch report',
        started_at: null,
        stt_seconds: 0,
        items: snapshotToHistoryItems(snap),
      })
      return
    }
    let gone = false
    void authApi<{ sessions: HistorySession[] }>('/api/account/history')
      .then((out) => {
        if (gone) return
        const session = pickWatchReportSession(out.sessions || [])
        if (!session) return
        restoreHistory(session)
      })
      .catch(() => undefined)
    return () => {
      gone = true
    }
  }, [restoreHistory])

  useEffect(() => {
    if (!isNativeApp()) return
    const reveal = () => {
      if (readWatchReport()) showWatchReport()
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') reveal()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pageshow', reveal)
    let removeApp: (() => void) | undefined
    void import('@capacitor/app').then(({ App }) => {
      const pending = App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) reveal()
      })
      void pending.then((handle) => {
        removeApp = () => {
          void handle.remove()
        }
      })
    }).catch(() => undefined)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pageshow', reveal)
      removeApp?.()
    }
  }, [])

  const handleSummary = useCallback(() => {
    generateNotes()
  }, [generateNotes])

  const handleListenAsk = useCallback((text: string, files?: AttachPayload[]) => {
    const s = stateRef.current
    const question = text.trim() || (files?.length ? `Please review: ${files.map((f) => f.name).join(', ')}` : '')
    if (!question) return
    dispatch({ type: 'expect_catch', kind: 'ask', title: 'Ask', question })
    void (async () => {
      try {
        const attach_id = await parkAttaches(files)
        window.api.send({
          type: 'ask',
          text: askPrompt(askContext(s.meetingLines, s.meetingEnded), question, s.notesLang, s.translateOn, s.speakerNames),
          attach_id,
          mode: 'listen_ask',
        })
      } catch (ex) {
        dispatch({
          type: 'engine',
          ev: { type: 'error', text: ex instanceof Error ? ex.message : 'Could not send the file' },
        })
      }
    })()
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
    spokenTranslate.current.delete(id)
    dispatch({ type: 'retry_translate', id })
    queueMicrotask(() => pumpTranslateRef.current())
  }, [])

  const writePdf = useCallback(async () => {
    const s = stateRef.current
    const when = new Date().toLocaleString()
    const blocks: Array<{
      kind: 'h1' | 'h2' | 'p' | 'meta' | 'bullet' | 'action' | 'decision' | 'flash' | 'concept' | 'line'
      text: string
      owner?: string
      ts?: string
      speaker?: string
    }> = []
    let title = PRODUCT_NAME
    let theme: 'plain' | 'meeting' | 'lecture' = 'plain'
    let meta: string[] = []
    let doc: ListenPdfDoc | undefined

    if (s.workspaceMode === 'translate') {
      title = `${PRODUCT_NAME} captions`
      blocks.push({ kind: 'h1', text: `${PRODUCT_NAME} captions` })
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
      title = `${PRODUCT_NAME} answers`
      blocks.push({ kind: 'h1', text: `${PRODUCT_NAME} answers` })
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
      const lecture = s.listenScene === 'lecture'
      theme = lecture ? 'lecture' : 'meeting'
      title = lecture ? 'Study notes' : 'Meeting notes'
      const lines = s.meetingLines
      const notes = parseNotes(s.notesRaw)
      const speakers = [...new Set(Object.values(s.speakerNames).filter(Boolean))]
      meta = [
        when,
        s.meetingElapsedMs ? formatElapsed(s.meetingElapsedMs) : '',
        speakers.length ? speakers.join(' · ') : '',
      ].filter(Boolean)
      const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      doc = buildListenPdfDoc({
        theme,
        summary: notes.summary,
        date,
        exported: when,
        duration: s.meetingElapsedMs ? formatElapsed(s.meetingElapsedMs) : '',
        speakers,
        keyPoints: notes.keyPoints,
        decisions: notes.decisions,
        actionItems: notes.actionItems,
        importantDetails: notes.importantDetails,
        followUps: notes.followUps,
        revisionNotes: notes.revisionNotes,
        catchNotes: s.catchNotes.map((n) => ({ title: n.title, text: n.text })),
        transcript: lines.map((ln) => ({
          ts: ln.ts,
          speaker: resolveSpeakerName(s.speakerNames, ln.speaker),
          text: ln.text,
          translation: s.translateOn ? ln.translation : undefined,
        })),
      })
      title = doc.title
      blocks.push({ kind: 'h1', text: title })
      if (lecture) {
        for (const id of sceneSectionOrder('lecture')) {
          if (id === 'summary') {
            if (notes.summary.trim()) {
              blocks.push({ kind: 'h2', text: sectionTitle('lecture', id) })
              blocks.push({ kind: 'p', text: notes.summary.trim() })
            }
          } else if (id === 'keyPoints') {
            if (notes.keyPoints.length) {
              blocks.push({ kind: 'h2', text: sectionTitle('lecture', id) })
              notes.keyPoints.forEach((item, i) => blocks.push({ kind: 'concept', text: item, owner: String(i + 1).padStart(2, '0') }))
            }
          } else if (id === 'importantDetails') {
            if (notes.importantDetails.length) {
              blocks.push({ kind: 'h2', text: sectionTitle('lecture', id) })
              for (const item of notes.importantDetails) blocks.push({ kind: 'bullet', text: item })
            }
          } else if (id === 'revisionNotes') {
            if (notes.revisionNotes.length) {
              blocks.push({ kind: 'h2', text: sectionTitle('lecture', id) })
              notes.revisionNotes.forEach((item) => blocks.push({ kind: 'flash', text: item, owner: 'Revise' }))
            }
          } else if (id === 'followUps') {
            if (notes.followUps.length) {
              blocks.push({ kind: 'h2', text: sectionTitle('lecture', id) })
              for (const item of notes.followUps) blocks.push({ kind: 'bullet', text: item })
            }
          }
        }
      } else {
        if (notes.summary.trim()) {
          blocks.push({ kind: 'h2', text: sectionTitle(s.listenScene, 'summary') })
          blocks.push({ kind: 'p', text: notes.summary.trim() })
        }
        if (notes.keyPoints.length) {
          blocks.push({ kind: 'h2', text: sectionTitle('meeting', 'keyPoints') })
          for (const item of notes.keyPoints) blocks.push({ kind: 'bullet', text: item })
        }
        if (notes.decisions.length) {
          blocks.push({ kind: 'h2', text: sectionTitle('meeting', 'decisions') })
          for (const item of notes.decisions) blocks.push({ kind: 'decision', text: item })
        }
        if (notes.actionItems.length) {
          blocks.push({ kind: 'h2', text: sectionTitle('meeting', 'actionItems') })
          for (const row of notes.actionItems) blocks.push({ kind: 'action', text: row.text, owner: row.owner })
        }
        if (notes.importantDetails.length) {
          blocks.push({ kind: 'h2', text: sectionTitle('meeting', 'importantDetails') })
          for (const item of notes.importantDetails) blocks.push({ kind: 'bullet', text: item })
        }
        if (notes.followUps.length) {
          blocks.push({ kind: 'h2', text: sectionTitle('meeting', 'followUps') })
          for (const item of notes.followUps) blocks.push({ kind: 'bullet', text: item })
        }
      }
      for (const note of s.catchNotes) {
        if (!note.text.trim()) continue
        blocks.push({ kind: 'h2', text: note.title })
        blocks.push({ kind: 'p', text: note.text.trim() })
      }
      blocks.push({ kind: 'h2', text: lecture ? 'Classroom stream' : 'Transcript' })
      if (lines.length === 0) blocks.push({ kind: 'p', text: 'No transcript lines.' })
      else {
        for (const ln of lines) {
          const who = resolveSpeakerName(s.speakerNames, ln.speaker)
          blocks.push({ kind: 'line', text: ln.text, ts: ln.ts, speaker: who })
          // Same-language passthrough: the translation equals the source, so a
          // second row would print it twice. (Fallback path of the export; the
          // template path dedups in pdfTemplates.sectionChunks.)
          if (s.translateOn && ln.translation && !sameSpokenLine(ln.text, ln.translation)) {
            blocks.push({ kind: 'line', text: ln.translation, ts: '', speaker: '' })
          }
        }
      }
    }

    try {
      const dest = await window.api.exportPdf({ title, blocks, theme, meta, doc })
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
      autoNotesTried.current = false
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
    const s = stateRef.current
    if (!s.notesRaw.trim() && s.meetingLines.length > 0 && !autoNotesTried.current) {
      // busy 期间点了导出：等它结束后补一次笔记生成，再导出（失败则直接导出已有内容，不重试循环）
      autoNotesTried.current = true
      generateNotes()
      return
    }
    exportAfterNotes.current = false
    void writePdf()
  }, [state.busy, state.notesRaw, writePdf, generateNotes])

  // A Save tapped while Notes were still streaming waits until they land, then
  // keeps the session (with its Notes section) instead of saving it empty.
  useEffect(() => {
    if (!keepAfterNotes.current || state.busy || state.notesAskId) return
    const job = keepAfterNotes.current
    keepAfterNotes.current = null
    if (!keepAfterNotesStillValid(job, saveBookRef.current)) return
    sendKeepNow({ content: job.content, audio: job.audio })
  }, [state.busy, state.notesAskId])

  // 'generating'/'transcribing' is an engine state, not a pause: it must not
  // freeze the clock, but it must not restart it either when paused.
  const [clockRunning, setClockRunning] = useState(false)
  useEffect(() => {
    if (state.engine === 'generating' || state.engine === 'transcribing') return
    setClockRunning(state.capture === 'listening' || state.capture === 'recording')
  }, [state.capture, state.engine])

  // Meeting elapsed clock
  useEffect(() => {
    if (state.workspaceMode !== 'meeting' || state.meetingStartedAt == null) return
    if (!clockRunning) return
    const id = window.setInterval(() => {
      tickRef.current += 1
      const started = stateRef.current.meetingStartedAt
      if (started) dispatch({ type: 'meeting_clock', startedAt: started, elapsedMs: Date.now() - started })
    }, 1000)
    return () => window.clearInterval(id)
  }, [state.workspaceMode, state.meetingStartedAt, clockRunning])

  if (!state.keys.hasLlm || !state.keys.hasStt) {
    return <KeySetup hasLlm={state.keys.hasLlm} hasStt={state.keys.hasStt} />
  }

  if (!isWeb && state.view !== 'workspace' && state.workspaceMode === 'interview') {
    const fullscreen = state.view === 'fullscreen'
    return (
      <div className={`app overlay-app${fullscreen ? ' fullscreen' : ''}`}>
        <AutoOverlay
          capture={state.capture}
          engine={state.engine}
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
            stopListen()
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

  const listening = sessionListening({ capture: state.capture })
  const study = studyMode
  const hideRail = () => {
    setRailDismissed(true)
    setRailHover(false)
  }
  const railOn = !study || !inQa || !railDismissed || railHover
  const sideRail = (
    <SideRail
      mode={state.workspaceMode}
      capture={state.capture}
      engine={state.engine}
      autoOn={state.autoOn}
      onPrimary={handlePrimary}
      onRecord={handleRecord}
      onPause={handlePause}
      onMark={handleMark}
      onExport={() => { void handleExportPdf() }}
      onClose={study && inQa ? hideRail : undefined}
      meetingPaused={meetingRailIsPaused({
        workspaceMode: state.workspaceMode,
        listening,
        userPaused: state.capture === 'paused',
        started: state.meetingStartedAt != null,
        ended: state.meetingEnded,
      })}
      onOpenHistory={() => setHistoryOpen(true)}
      onNewSession={handleNewSession}
      onSaveSession={() => {
        if (historyKept) {
          setHistoryOpen(true)
          return
        }
        saveLiveSession()
      }}
      canSaveSession={sessionShouldOfferSave({
        workspaceMode: state.workspaceMode,
        ended: state.meetingEnded,
        kept: historyKept,
        hasContent: meetingHasSaveableContent(state),
        listening,
        paused: state.capture === 'paused',
      })}
      sessionSaved={state.workspaceMode === 'meeting' && historyKept && meetingHasSaveableContent(state)}
    />
  )

  const iphonePaused = state.capture === 'paused'
  const canSaveSession = sessionShouldOfferSave({
    workspaceMode: state.workspaceMode,
    ended: state.meetingEnded,
    kept: historyKept,
    hasContent: meetingHasSaveableContent(state),
    listening,
    paused: state.capture === 'paused',
  })
  const phoneActions = phone ? (
    <IphoneActions
      listening={listening}
      paused={iphonePaused}
      muted={state.micMuted}
      elapsedMs={state.meetingElapsedMs}
      canSave={canSaveSession}
      hasContent={meetingHasSaveableContent(state) || state.translatePairs.length > 0}
      saved={historyKept && meetingHasSaveableContent(state)}
      ended={state.workspaceMode === 'meeting' && state.meetingEnded}
      variant={state.workspaceMode === 'translate' ? 'translate' : state.workspaceMode === 'interview' ? 'interview' : 'listen'}
      onStart={handlePrimary}
      onPause={handlePause}
      onResume={handleResume}
      onStop={handleStop}
      onMore={() => setMoreOpen(true)}
      moreOpen={moreOpen}
      onCloseMore={() => setMoreOpen(false)}
      onExportPdf={() => { void handleExportPdf() }}
      onSave={() => {
        if (historyKept) {
          setHistoryOpen(true)
          return
        }
        saveLiveSession()
      }}
      onHistory={() => setHistoryOpen(true)}
      onNew={handleNewSession}
    />
  ) : null

  return (
    <div className={`app${phone ? ' iphone-v2' : ''}${historyOpen ? ' hist-open' : ''}${phone && state.workspaceMode === 'translate' ? ' translate-mode' : ''}`}>
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
        onOpenHistory={() => setHistoryOpen(true)}
        onMore={() => setMoreOpen(true)}
        ttsMode={ttsMode}
        ttsVoice={ttsVoice}
        onTtsMode={(mode) => {
          setTtsMode(mode)
          writeTtsMode(mode)
          if (mode === 'tap') stopSpeech()
          if (mode === 'live') unlockSpeech()
        }}
        onTtsVoice={(voice) => {
          setTtsVoice(voice)
          writeTtsVoice(voice)
        }}
        listening={listening}
        elapsedMs={
          state.workspaceMode === 'meeting' && state.meetingStartedAt != null
            ? state.meetingElapsedMs
            : undefined
        }
      />
      <HistoryPane open={historyOpen} onClose={() => setHistoryOpen(false)} onRestore={restoreHistory} />
      <SavePrompt
        open={savePrompt}
        secondary={savePromptMode}
        onKeep={(opts) => {
          setSavePrompt(false)
          const restoredId = pendingRestoreId.current
          pendingRestoreId.current = null
          // Remember the restored id so a matching history_kept ack (for the OLD
          // half-session) does not mark the live session kept.
          lastRestoredKeepId.current = restoredId
          if (restoredId) {
            window.api.send({ type: 'keep_history', id: restoredId, content: opts.content, audio: opts.audio })
            return
          }
          saveLiveSession({ content: opts.content, audio: opts.audio, fromPrompt: true })
        }}
        onCancel={() => {
          setSavePrompt(false)
          commitBook(cancelCollect(saveBookRef.current))
        }}
        onDiscard={() => {
          setSavePrompt(false)
          const restoredId = pendingRestoreId.current
          pendingRestoreId.current = null
          if (restoredId) {
            // Recovered session: discard it by id (not the live usage id).
            markHistoryKept(false)
            window.api.send({ type: 'discard_history', id: restoredId })
            return
          }
          markHistoryKept(false)
          window.api.send({ type: 'discard_history' })
          if (pendingNewAfterSave.current) {
            pendingNewAfterSave.current = false
            doClear()
            dispatch({ type: 'engine', ev: { type: 'status', text: 'New session' } })
          }
        }}
      />
      <div className={`workspace${study ? ' study' : ''}${study && railOn ? ' rail-on' : ''}`}>
        {study && !railOn && (
          <button
            type="button"
            className={`rail-hint${listening ? ' live' : ''}`}
            title="Show controls"
            aria-label="Show controls"
            onClick={() => {
              setRailDismissed(false)
              setRailHover(true)
            }}
          >
            <span className="rail-hint-chevron" aria-hidden="true">›</span>
            <span className="rail-hint-label">Controls</span>
          </button>
        )}
        {!phone && (
        <div
          className="rail-slot"
          onMouseEnter={() => {
            if (!study || !inQa) return
            setRailHover(true)
          }}
          onMouseLeave={() => study && setRailHover(false)}
        >
          {sideRail}
        </div>
        )}
        {state.workspaceMode === 'translate' ? (
          <TranslatePane
            pairs={state.translatePairs}
            partial={state.partial}
            bindId={state.translateBindId}
            to={state.translateTo}
            from={state.translateFrom}
            heardFrom={state.translateFrom === 'auto' ? state.heardLang : state.translateFrom}
            onTranslate={handleTranslateTyped}
            onTranslateTo={handleTranslateTo}
            onTranslateFrom={handleTranslateFrom}
            onSwap={handleSwapTranslate}
            onCopyField={copyPairField}
            onRetry={handleRetryTranslate}
            ttsMode={ttsMode}
            ttsVoice={ttsVoice}
            onTtsMode={(mode) => {
              setTtsMode(mode)
              writeTtsMode(mode)
              if (mode === 'tap') stopSpeech()
              if (mode === 'live') unlockSpeech()
            }}
            onTtsVoice={(voice) => {
              setTtsVoice(voice)
              writeTtsVoice(voice)
            }}
            voiceChrome={phone ? undefined : (
              <TitleIcons
                mode={state.workspaceMode}
                source={state.source}
                opacity={state.opacity}
                pinned={state.pinned}
                systemMuted={state.systemMuted}
                micMuted={state.micMuted}
                stealth={state.stealth}
                onSource={handleSource}
                onOpacity={handleOpacity}
                onPinned={handlePinned}
                onSystemMuted={handleSystemMuted}
                onMicMuted={handleMicMuted}
                onStealth={handleStealth}
                onFullScreen={() => dispatch({ type: 'view', view: 'fullscreen' })}
              />
            )}
            actions={phoneActions}
            speaking={speaking}
            onStopSpeech={stopSpeech}
            onSpeak={(text) => {
              if (speechTapShouldStop(speaking)) {
                stopSpeech()
                return
              }
              unlockSpeech()
              void speakTranslation(text, ttsVoice).catch((err) => {
                dispatch({
                  type: 'engine',
                  ev: { type: 'status', text: err instanceof Error ? err.message : 'Could not speak translation' },
                })
              })
            }}
          />
        ) : (
          <ListenPane
            scene={state.workspaceMode === 'interview' ? 'interview' : state.listenScene}
            speechLang={state.lang}
            heardLang={state.heardLang}
            onSpeechLang={handleLang}
            translateOn={state.translateOn}
            translateTo={state.translateTo}
            notesLang={state.notesLang}
            lines={state.meetingLines}
            speakerNames={state.speakerNames}
            partialSpeaker={state.partialSpeaker}
            onRenameSpeaker={handleRenameSpeaker}
            partial={state.partial}
            listening={listening}
            paused={iphonePaused}
            ended={state.meetingEnded}
            catchNotes={state.catchNotes}
            notesRaw={state.notesRaw}
            busy={state.busy}
            summarizing={Boolean(state.notesAskId)}
            notesDefaultOpen={demoScene === 'meeting-notes' || watchReportOpen}
            notesReveal={watchReportReveal}
            qa={state.workspaceMode === 'interview'}
            qaSlot={
              <AnswerPane
                currentQ={state.currentQ}
                partial={state.partial}
                turns={state.turns}
                busy={state.busy}
                listening={listening}
                onAsk={handleAsk}
                onCompose={setComposeOpen}
              />
            }
            onScene={(scene) => {
              const s = stateRef.current
              if (listenSettingsBlocked({ capture: s.capture, workspaceMode: s.workspaceMode })) {
                dispatch({ type: 'engine', ev: { type: 'status', text: IPHONE_COPY.settingsLocked } })
                return
              }
              dispatch({ type: 'listen_scene', scene })
              if (scene === 'interview') handleMode('interview', 'interview')
              else if (s.workspaceMode !== 'meeting') handleMode('meeting', scene)
              else window.api.send({ type: 'set_workspace', mode: 'meeting', scene, speakers_expected: speakersExpected(scene, meetingSpeakerCount()) })
            }}
            onTranslate={(on) => {
              const s = stateRef.current
              if (listenSettingsBlocked({ capture: s.capture, workspaceMode: s.workspaceMode })) {
                dispatch({ type: 'engine', ev: { type: 'status', text: IPHONE_COPY.settingsLocked } })
                return
              }
              if (on === s.translateOn) return
              dispatch({ type: 'translate_on', on })
              if (!on) killInflightTranslation()
              if (on) queueMicrotask(() => pumpTranslateRef.current())
            }}
            onTranslateTo={handleTranslateTo}
            meetingSpeakersId={meetingSpeakersId}
            onMeetingSpeakers={handleMeetingSpeakers}
            onSummary={handleSummary}
            onAsk={handleListenAsk}
            elapsedMs={state.meetingElapsedMs}
            onExportPdf={() => { void handleExportPdf() }}
            actions={phoneActions}
            showSavedLine={phone && state.workspaceMode === 'meeting' && historyKept && meetingHasSaveableContent(state)}
            saveBanner={
              saveBannerOpen && saveBook.status !== 'saved' ? (
                <SaveBanner
                  status={saveBook.status}
                  onSave={() => saveLiveSession()}
                  onNotNow={() => setSaveBannerOpen(false)}
                  onRetry={() => saveLiveSession()}
                />
              ) : null
            }
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
              The first time you enable the microphone, Nodpilot sends audio to AssemblyAI and text to a language model.
              Tell others in the room if they must know. You can
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
