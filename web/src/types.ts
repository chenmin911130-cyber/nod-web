import type { ListenFlushWait } from './recordReport'
import type { UplinkLinkState } from './linkState'

export type CaptureState = 'off' | 'listening' | 'recording' | 'paused'
export type EngineState = 'idle' | 'transcribing' | 'generating'
// #182 Think: the sources a Think answer actually retrieved. `status` is the
// honest summary the server sent — `ok` only when usable results exist.
export type AnswerSource = { title: string; url: string; published_at: string | null }
export type AnswerSources = {
  status: 'ok' | 'empty' | 'failed'
  retrieved_at: number
  retrieved_at_text: string
  results: AnswerSource[]
  note: string
}
// #182 Think: `think` is the value the question was SUBMITTED with (the server
// echoes it back), so a Retry can re-ask it the way it originally ran.
// #182 Think: `think` is the value the question was SUBMITTED with (the server
// echoes it back) and `submitId` names the original submission payload, so a
// Retry can rebuild the exact same request instead of guessing from the display
// text. `live` marks a turn created from a real submission in THIS session — a
// restored/history (or demo) turn has neither the value nor the payload, so it
// must not offer a Retry it cannot honour.
export type Turn = { id: string; q: string; a: string; sources?: AnswerSources; think?: boolean; submitId?: string; live?: boolean }
export type CatchNote = {
  id: string
  title: string
  text: string
  kind?: 'catch' | 'ask'
  question?: string
  at?: number
}
export type ViewMode = 'workspace' | 'focus' | 'fullscreen'
export type AudioSource = 'system' | 'both' | 'mic'
export type WorkspaceMode = 'interview' | 'meeting' | 'translate'
export type PairLang = 'zh' | 'ja' | 'en' | 'it' | 'es' | 'fr' | 'de' | 'pt'
export type Lang = 'auto' | PairLang

export const TRANSLATE_LANGS: Array<{ id: PairLang; tag: string; name: string }> = [
  { id: 'zh', tag: 'CH', name: 'Chinese' },
  { id: 'ja', tag: 'JA', name: 'Japanese' },
  { id: 'en', tag: 'EN', name: 'English' },
  { id: 'it', tag: 'IT', name: 'Italian' },
  { id: 'es', tag: 'ES', name: 'Spanish' },
  { id: 'fr', tag: 'FR', name: 'French' },
  { id: 'de', tag: 'DE', name: 'German' },
  { id: 'pt', tag: 'PT', name: 'Portuguese' },
]

export const STT_LANGS = TRANSLATE_LANGS.filter((l) => l.id === 'zh' || l.id === 'ja' || l.id === 'en')

export interface ModelDef {
  label: string
  provider: string
  model: string
}

export interface AppConfig {
  llm?: { provider?: string; model?: string; max_tokens?: number; temperature?: number }
  stt?: { model?: string; language?: string | null }
  audio?: { source?: string }
  ui?: { opacity?: number; translate_from?: Lang; translate_to?: PairLang }
  models?: ModelDef[]
  has_tts?: boolean
}

import type { ListenGap } from './listenGap'

export interface MeetingLine {
  id: string
  ts: string
  text: string
  marked?: boolean
  at?: number
  /** Last final text or line_update; backlog wait + translate latency (does not replace `at`). */
  updatedAt?: number
  translation?: string
  speaker?: string
  /** Set when translation gave up after the retry budget; pump skips it. */
  translateFailed?: boolean
  /** STT language tag for this turn (from the question event), for passthrough. */
  lang?: PairLang
  /** Bumped by a line_update extend; gates stale translate chunks/dones. */
  rev?: number
}

export interface TranslatePair {
  id: string
  ts: string
  original: string
  translation: string
  to?: PairLang
  from?: PairLang
  failed?: boolean
  passthrough?: boolean
  // Server copy version this row's text is current to (#219). Both the
  // incremental chunk and the full watch_copy snapshot carry it.
  copySeq?: number
  // Stable sentence position in the copy session: recovery orders by this, never
  // by `copySeq` (a retry moves the version, not the sentence).
  copyOrder?: number
}

export interface AppState {
  capture: CaptureState
  engine: EngineState
  status: string
  currentQ: string
  currentQId: string
  turns: Turn[]
  partial: string
  busy: boolean
  // #182: the session's Think switch. Off on cold start, off again after New /
  // clear / restoring a saved session; kept while the same session lives.
  thinkOn: boolean
  // Bumped every time the socket (re)attaches, so the Think value can be
  // re-asserted to the server without silently inverting it.
  wsAttachSeq: number
  opacity: number
  pinned: boolean
  micMuted: boolean
  systemMuted: boolean
  stealth: boolean
  view: ViewMode
  draft: string
  llm: { provider: string; model: string }
  lang: Lang
  source: AudioSource
  autoOn: boolean
  models: ModelDef[]
  keys: { hasLlm: boolean; hasStt: boolean }
  workspaceMode: WorkspaceMode
  meetingLines: MeetingLine[]
  listenGaps: ListenGap[]
  meetingStartedAt: number | null
  meetingPausedAt: number | null
  meetingElapsedMs: number
  meetingEnded: boolean
  composeSessionId: number
  translatePairs: TranslatePair[]
  // #219: the server's current Watch copy session. A row that names another
  // session is a replay/frame from a session the phone already cleared.
  watchSession: string
  translateFrom: Lang
  translateTo: PairLang
  notesLang: Lang
  notesTranslateTo: PairLang
  heardLang: PairLang | null
  translateAskId: string
  translateBindId: string
  translateBindRev: number
  listenScene: 'meeting' | 'lecture' | 'interview'
  translateOn: boolean
  catchNotes: CatchNote[]
  catchPendingTitle: string
  catchAskId: string
  notesRaw: string
  notesAskId: string
  speakerNames: Record<string, string>
  speakerNameLocked: Record<string, boolean>
  speakerDecided: Record<string, 'confirmed' | 'dismissed'>
  partialSpeaker: string
  quota: {
    ok: boolean
    stt_seconds: number
    stt_limit: number
    daily_stt_seconds: number
    daily_stt_limit: number
    llm_tokens: number
    llm_limit: number
    sessions: number
    session_limit: number
    daily_cost_usd: number
    daily_cost_limit: number
    quota_disabled?: boolean
  } | null
  listenFlushWait: ListenFlushWait
  link: 'online' | 'reconnecting'
  uplink: UplinkLinkState | null
}

// 引擎 → 前端
export type EngineEvent =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'keys_status'; has_llm: boolean; has_stt: boolean }
  | { type: 'phase'; capture: CaptureState; engine: EngineState }
  | { type: 'status'; text: string }
  | { type: 'partial'; text: string; language?: string; speaker?: string }
  | { type: 'question'; id: string; text: string; language?: string; speaker?: string; think?: boolean; submit_id?: string; server_translate?: boolean; translation?: string; order?: number }
  | { type: 'line_update'; id: string; text: string; language?: string; speaker?: string; rev: number }
  // #219: which Watch copy session is current (New / clear / switch mode / Start
  // mint a new one). The phone needs it to tell a fresh session from a replay.
  | { type: 'watch_session'; session_id: string }
  // #219: the copy session's Translate rows, sent on reconnect so a phone that was
  // locked longer than the native replay (24 rows) can fill in the gaps.
  | { type: 'translate_rows'; session_id?: string; rows: Array<{ id: string; original: string; translation: string; failed?: boolean; seq?: number; order?: number }>; has_more?: boolean; oldest_order?: number }
  // #219 follow-up: the Live Q&A lane's turns, sent on reconnect so the phone pane
  // matches the answer the locked native path already put on the Watch.
  | { type: 'qa_rows'; session_id?: string; rows: Array<{ id: string; question: string; answer: string; failed?: boolean; done?: boolean; seq?: number; order?: number }>; has_more?: boolean; oldest_order?: number }
  | { type: 'chunk'; id: string; text: string; copy_seq?: number; copy_id?: string }
  | ({ type: 'sources'; id?: string } & AnswerSources)
  // #182: the server's authoritative Think value. Sent when a session reset turns
  // the switch back to its default, so the client never shows a stale "on".
  | { type: 'think'; on: boolean }
  | { type: 'done'; id: string; stt: number; llm: number; ok: boolean; copy_id?: string; copy_failed?: boolean }
  | { type: 'error'; text: string; id?: string }
  | { type: 'listen_taken'; text: string }
  | { type: 'auth_required' }
  | { type: 'quota'; ok: boolean; reason?: string; plan?: string; plan_name?: string; stt_seconds: number; stt_limit: number; llm_tokens: number; llm_limit: number; sessions?: number; session_limit?: number; daily_cost_usd?: number; daily_cost_limit?: number; daily_stt_seconds?: number; daily_stt_limit?: number; quota_disabled?: boolean }
  | { type: 'quota_exceeded'; reason: string }
  | { type: 'save_prompt'; id?: string; text?: string; mode?: string }
  | { type: 'history_kept'; id?: string }
  | { type: 'history_keep_failed'; id?: string; reason?: string }
  | { type: 'disconnected' }
  | { type: 'attached'; usage_session_id?: string }
  | { type: 'pcm_drained'; id: string; capture_id: string; byte_offset: number }
  | { type: 'listen_flush'; id?: string; flush_id?: string; session_id?: string; ok: boolean; timeout?: boolean }
  | { type: 'listen_gap'; id: string; from_ms: number; to_ms: number; reason?: string }

// 前端 → 引擎
export type EngineMsg =
  | { type: 'manual' }
  | { type: 'toggle_listen' }
  | { type: 'start_listen'; mic?: 'watch' | 'phone' }
  | { type: 'stop_listen'; flush_id?: string }
  | { type: 'pause_listen' }
  | { type: 'resume_listen' }
  | { type: 'keep_history'; content?: boolean; audio?: boolean; id?: string }
  | { type: 'discard_history'; id?: string }
  | { type: 'auth'; token: string }
  | { type: 'ask'; text: string; files?: Array<{ name: string; mime: string; data: string }>; attach_id?: string; mode?: string; think?: boolean; retry_of?: string; submit_id?: string }
  | { type: 'set_workspace'; mode: WorkspaceMode; scene?: 'meeting' | 'lecture' | 'interview'; speakers_expected?: number }
  | { type: 'set_llm'; provider: string; model: string }
  | { type: 'set_think'; on: boolean }
  | { type: 'set_lang'; language: string | null }
  | { type: 'set_source'; source: string }
  | { type: 'set_mic_muted'; muted: boolean }
  | { type: 'save_keys'; deepseek_key: string; assemblyai_key: string }
  | { type: 'clear' }
  | { type: 'cancel_generate' }
  | { type: 'set_translate_from'; language: PairLang | null }
  | { type: 'set_translate_to'; lang: PairLang }
  // #219: ask for the copy session's Translate rows (reconnect/wake catch-up).
  // `before` walks backwards past the server's batch size.
  | { type: 'copy_rows'; before?: number }
  | { type: 'ping' }

export interface Api {
  send(msg: EngineMsg): void
  onEvent(cb: (e: EngineEvent) => void): () => void
  onShortcut(cb: (k: 'f2' | 'f3' | 'f4' | 'f8' | 'f9') => void): () => void
  setOpacity(n: number): void
  setPinned(b: boolean): void
  setStealth(on: boolean): void
  setView(mode: ViewMode): void
  copy(text: string): Promise<boolean>
  close(): void
  minimize(): void
  getConfig(): Promise<AppConfig>
  openExternal(url: string): void
  exportPdf(payload: {
    title?: string
    html?: string
    dest?: string
    theme?: 'plain' | 'meeting' | 'lecture'
    subtitle?: string
    meta?: string[]
    doc?: import('./pdfTemplates').ListenPdfDoc
    blocks?: Array<{
      kind: 'h1' | 'h2' | 'p' | 'meta' | 'bullet' | 'action' | 'decision' | 'flash' | 'concept' | 'line'
      text: string
      owner?: string
      ts?: string
      speaker?: string
    }>
  }): Promise<string>
}

declare global {
  interface Window {
    api: Api
  }
}
