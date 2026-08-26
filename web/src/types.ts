export type RunState = 'idle' | 'record' | 'listen' | 'think'
export type Turn = { id: string; q: string; a: string }
export type CatchNote = {
  id: string
  title: string
  text: string
  kind?: 'catch' | 'ask'
  question?: string
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
}

export interface MeetingLine {
  id: string
  ts: string
  text: string
  marked?: boolean
  at?: number
  translation?: string
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
  run: RunState
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
  meetingSummary: string
  meetingStartedAt: number | null
  meetingPausedAt: number | null
  meetingElapsedMs: number
  meetingEnded: boolean
  translatePairs: TranslatePair[]
  translateFrom: Lang
  translateTo: PairLang
  heardLang: PairLang | null
  bilingual: boolean
  translateAskId: string
  translateBindId: string
  summaryAskId: string
  listenScene: 'meeting' | 'lecture' | 'interview'
  translateOn: boolean
  catchNotes: CatchNote[]
  catchPendingTitle: string
  catchAskId: string
  notesRaw: string
  notesAskId: string
  quota: {
    ok: boolean
    stt_seconds: number
    stt_limit: number
    llm_tokens: number
    llm_limit: number
  } | null
}

// 引擎 → 前端
export type EngineEvent =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'keys_status'; has_llm: boolean; has_stt: boolean }
  | { type: 'state'; state: string }
  | { type: 'status'; text: string }
  | { type: 'partial'; text: string; language?: string }
  | { type: 'question'; id: string; text: string; language?: string }
  | { type: 'chunk'; id: string; text: string }
  | { type: 'done'; id: string; stt: number; llm: number; ok: boolean }
  | { type: 'error'; text: string }
  | { type: 'auth_required' }
  | { type: 'quota'; ok: boolean; reason?: string; plan?: string; plan_name?: string; stt_seconds: number; stt_limit: number; llm_tokens: number; llm_limit: number; sessions?: number; session_limit?: number; daily_cost_usd?: number; daily_cost_limit?: number; quota_disabled?: boolean }
  | { type: 'quota_exceeded'; reason: string }

// 前端 → 引擎
export type EngineMsg =
  | { type: 'manual' }
  | { type: 'toggle_listen' }
  | { type: 'ask'; text: string; files?: Array<{ name: string; mime: string; data: string }>; mode?: string }
  | { type: 'set_workspace'; mode: WorkspaceMode }
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
  exportPdf(payload: { title?: string; html?: string; dest?: string; blocks?: Array<{ kind: 'h1' | 'h2' | 'p' | 'meta'; text: string }> }): Promise<string>
}

declare global {
  interface Window {
    api: Api
  }
}
