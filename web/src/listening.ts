export type ListeningMode =
  | 'lecture'
  | 'meeting'
  | 'conversation'
  | 'presentation'
  | 'training'
  | 'general'
  | 'interview_notes'

export const LISTENING_MODES: Array<{ id: ListeningMode; label: string }> = [
  { id: 'lecture', label: 'Lecture' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'presentation', label: 'Presentation' },
  { id: 'training', label: 'Training' },
  { id: 'general', label: 'General' },
  { id: 'interview_notes', label: 'Interview Notes' },
]

const STORAGE_KEY = 'nod_listening_mode'

export function isListeningMode(value: unknown): value is ListeningMode {
  return LISTENING_MODES.some((m) => m.id === value)
}

export function readListeningMode(): ListeningMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (isListeningMode(raw)) return raw
  } catch {
    /* ignore */
  }
  return 'meeting'
}

export function persistListeningMode(mode: ListeningMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
}

export function notesPromptPrefix(mode: ListeningMode): string {
  return `[NOD_NOTES:${mode}]`
}

export function askNodPrefix(): string {
  return '[NOD_ASK]'
}
