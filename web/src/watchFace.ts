import { watchVisibleOriginal } from './watchStatus'

export type WatchPhase =
  | 'ready'
  | 'listening'
  | 'paused'
  | 'translateListening'
  | 'translateResult'
  | 'qaWaiting'
  | 'qaDrafting'
  | 'qaAnswer'
  | 'ended'
  | 'saving'
  | 'saved'
  | 'saveFailed'

export type WatchScreen = {
  phase: WatchPhase
  mascot: false
  showModePicker: boolean
  showHistoryList: false
  modeLabel: string
  langPair?: string
  status?: string
  statusEn?: string
  original?: string
  translation?: string
  previous?: string
  question?: string
  answer?: string
  primary?: string
  secondary?: string
  tertiary?: string
  playLabel?: string
  rec?: boolean
  clipLines?: number
  crownScroll?: boolean
  swipeStop?: boolean
  waveform?: boolean
  saveStacked?: boolean
  secondaryTone?: 'bright'
}

export type WatchAlwaysOn = {
  show: boolean
  modeLabel?: string
  line?: string
  showTimer: boolean
  recDot: boolean
}

export function watchLangPair(to: string): string {
  const tags: Record<string, string> = {
    zh: 'CH',
    ja: 'JA',
    en: 'EN',
    it: 'IT',
    es: 'ES',
    fr: 'FR',
    de: 'DE',
    pt: 'PT',
  }
  return `Auto → ${tags[to] || 'CH'}`
}

export function buildWatchScreen(input: {
  workspaceMode: string
  listenScene: string
  listening: boolean
  paused: boolean
  ended?: boolean
  save?: string
  elapsedMs?: number
  original: string
  translation: string
  previous?: string
  question: string
  answer: string
  drafting: boolean
  translateTo?: string
}): WatchScreen {
  const base = {
    mascot: false as const,
    showModePicker: false,
    showHistoryList: false as const,
    modeLabel: modeCapsule(input.workspaceMode, input.listenScene),
  }

  if (meetingEndedFace(input)) {
    const save = input.save || 'none'
    if (save === 'saving') {
      return {
        ...base,
        phase: 'saving',
        status: '保存中…',
        statusEn: 'Saving…',
      }
    }
    if (save === 'saved') {
      return {
        ...base,
        phase: 'saved',
        status: '已保存到历史记录',
        statusEn: 'Saved to History',
        primary: 'Continue recording',
      }
    }
    if (save === 'failed') {
      return {
        ...base,
        phase: 'saveFailed',
        status: '未能保存',
        statusEn: "Couldn't save",
        primary: 'Retry save',
      }
    }
    return {
      ...base,
      phase: 'ended',
      status: '已结束',
      statusEn: 'Ended',
      primary: 'Save',
      secondary: 'Continue recording',
      tertiary: "Don't save",
    }
  }

  if (input.workspaceMode === 'interview' || input.listenScene === 'interview') {
    if (input.answer.trim()) {
      return {
        ...base,
        phase: 'qaAnswer',
        question: input.question,
        answer: input.answer,
        previous: input.previous || undefined,
        clipLines: 3,
        crownScroll: true,
        swipeStop: true,
        waveform: true,
      }
    }
    if (input.drafting && input.question.trim()) {
      return {
        ...base,
        phase: 'qaDrafting',
        question: input.question,
        status: '起草中',
        statusEn: 'Drafting',
        swipeStop: true,
      }
    }
    if (input.listening) {
      return {
        ...base,
        phase: 'qaWaiting',
        status: '听问题',
        statusEn: 'Listening for a question',
        rec: true,
        swipeStop: true,
      }
    }
  }

  if (input.workspaceMode === 'translate' && input.listening && input.translation.trim()) {
    return {
      ...base,
      phase: 'translateResult',
      langPair: watchLangPair(input.translateTo || 'zh'),
      original: watchVisibleOriginal(input.original, input.translation),
      translation: input.translation,
      previous: input.previous || undefined,
      clipLines: 3,
      crownScroll: true,
      swipeStop: true,
      waveform: true,
      rec: true,
    }
  }

  if (input.workspaceMode === 'translate' && input.listening && !input.translation.trim()) {
    return {
      ...base,
      phase: 'translateListening',
      langPair: watchLangPair(input.translateTo || 'zh'),
      previous: input.previous || undefined,
      status: '听着',
      statusEn: 'listening',
      rec: true,
      swipeStop: true,
      waveform: true,
    }
  }

  if (input.paused) {
    return {
      ...base,
      phase: 'paused',
      status: '已暂停',
      statusEn: 'Paused',
      primary: 'Resume',
      secondary: 'End recording',
      swipeStop: true,
    }
  }

  if (input.listening) {
    return {
      ...base,
      phase: 'listening',
      status: '录音中',
      statusEn: 'Recording',
      primary: 'Pause',
      secondary: 'End recording',
      rec: true,
      swipeStop: true,
    }
  }

  return {
    ...base,
    phase: 'ready',
    primary: 'Start',
  }
}

/** Phone workspace → Watch read-only capsule id. */
export function watchStatusMode(workspaceMode: string, listenScene: string): WatchListenMode {
  if (workspaceMode === 'translate') return 'translate'
  if (workspaceMode === 'interview' || listenScene === 'interview') return 'interview'
  if (listenScene === 'lecture') return 'lecture'
  return 'meeting'
}

type WatchListenMode = 'meeting' | 'lecture' | 'interview' | 'translate'

export function buildWatchAlwaysOn(input: {
  workspaceMode: string
  listenScene: string
  listening: boolean
  paused: boolean
  ended?: boolean
  save?: string
  translation: string
  answer: string
}): WatchAlwaysOn {
  if (input.ended || (!input.listening && !input.paused)) {
    return { show: false, showTimer: false, recDot: false }
  }
  if (input.paused) {
    return { show: true, line: '已暂停', showTimer: true, recDot: false }
  }
  if (input.workspaceMode === 'interview' || input.listenScene === 'interview') {
    return { show: true, modeLabel: 'Live Q&A', showTimer: true, recDot: false }
  }
  if (input.workspaceMode === 'translate') {
    const line = input.translation.trim()
    return { show: true, line: line || undefined, showTimer: false, recDot: false }
  }
  return { show: true, showTimer: true, recDot: true }
}

/** A new caption must not change which listen pane is showing. */
export function watchListenPane(mode: string, _hasCopy: boolean): 'translate' | 'qa' | 'listen' {
  if (mode === 'translate') return 'translate'
  if (mode === 'interview') return 'qa'
  return 'listen'
}

function meetingEndedFace(input: {
  workspaceMode: string
  listenScene: string
  ended?: boolean
}): boolean {
  if (!input.ended) return false
  if (input.workspaceMode === 'translate' || input.workspaceMode === 'interview') return false
  if (input.listenScene === 'interview') return false
  return true
}

function modeCapsule(workspaceMode: string, listenScene: string): string {
  if (workspaceMode === 'translate') return 'Translate'
  if (workspaceMode === 'interview' || listenScene === 'interview') return 'Live Q&A'
  if (listenScene === 'lecture') return 'Lecture'
  return 'Meeting'
}
