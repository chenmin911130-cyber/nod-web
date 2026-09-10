export type CaptureState = 'off' | 'listening' | 'recording' | 'paused'
export type EngineState = 'idle' | 'transcribing' | 'generating'
export type Turn = { id: string; q: string; a: string }
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

export interface MeetingLine {
  id: string
  ts: string
  text: string
  marked?: boolean
  at?: number
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
  meetingStartedAt: number | null
  meetingPausedAt: number | null
  meetingElapsedMs: number
  meetingEnded: boolean
  translatePairs: TranslatePair[]
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
  listenFlush: 'idle' | 'pending' | 'complete' | 'timeout'
  listenFlushId: string
}

// 引擎 → 前端
export type EngineEvent =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'keys_status'; has_llm: boolean; has_stt: boolean }
  | { type: 'phase'; capture: CaptureState; engine: EngineState }
  | { type: 'status'; text: string }
  | { type: 'partial'; text: string; language?: string; speaker?: string }
  | { type: 'question'; id: string; text: string; language?: string; speaker?: string }
  | { type: 'line_update'; id: string; text: string; language?: string; speaker?: string; rev: number }
  | { type: 'chunk'; id: string; text: string }
  | { type: 'done'; id: string; stt: number; llm: number; ok: boolean }
  | { type: 'error'; text: string }
  | { type: 'listen_taken'; text: string }
  | { type: 'auth_required' }
  | { type: 'quota'; ok: boolean; reason?: string; plan?: string; plan_name?: string; stt_seconds: number; stt_limit: number; llm_tokens: number; llm_limit: number; sessions?: number; session_limit?: number; daily_cost_usd?: number; daily_cost_limit?: number; daily_stt_seconds?: number; daily_stt_limit?: number; quota_disabled?: boolean }
  | { type: 'quota_exceeded'; reason: string }
  | { type: 'save_prompt'; id?: string; text?: string }
  | { type: 'history_kept'; id?: string }
  | { type: 'history_keep_failed'; id?: string; reason?: string }
  | { type: 'disconnected' }
  | { type: 'attached'; usage_session_id?: string }
  | { type: 'pcm_drained'; id: string; capture_id: string; byte_offset: number }
  | { type: 'listen_flush'; id?: string; ok: boolean; timeout?: boolean }

// 前端 → 引擎
export type EngineMsg =
  | { type: 'manual' }
  | { type: 'toggle_listen' }
  | { type: 'start_listen'; mic?: 'watch' | 'phone' }
  | { type: 'stop_listen' }
  | { type: 'pause_listen' }
  | { type: 'resume_listen' }
  | { type: 'keep_history'; content?: boolean; audio?: boolean; id?: string }
  | { type: 'discard_history'; id?: string }
  | { type: 'auth'; token: string }
  | { type: 'ask'; text: string; files?: Array<{ name: string; mime: string; data: string }>; attach_id?: string; mode?: string }
  | { type: 'set_workspace'; mode: WorkspaceMode; scene?: 'meeting' | 'lecture' | 'interview'; speakers_expected?: number }
  | { type: 'set_llm'; provider: string; model: string }
  | { type: 'set_lang'; language: string | null }
  | { type: 'set_source'; source: string }
  | { type: 'set_mic_muted'; muted: boolean }
  | { type: 'save_keys'; deepseek_key: string; assemblyai_key: string }
  | { type: 'clear' }
  | { type: 'cancel_generate' }
  | { type: 'set_translate_from'; language: PairLang | null }
  | { type: 'set_translate_to'; lang: PairLang }
  | { type: 'ping' }

export interface Api {
  send(msg: EngineMsg): void
  onEvent(cb: (e: EngineEvent) => void): () => void
  onShortcut(cb: (k: 'f2' | 'f3' | 'f4' | 'f8' | 'f9') => void): () => void
  setOpacity(n: number): void
  setPinned(b: boolean): void
  setStealth(on: boolean): void
  setView(mode: ViewMode): void
  copy(text: string): void
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
