import type { NotesDoc } from './listen'

export type SpeakerSuggestion = {
  speakerId: string
  name: string
  evidence?: string
}

export function speakerSuggestions(input: {
  speakers: NotesDoc['speakers']
  speakerNames: Record<string, string>
  decided: Record<string, 'confirmed' | 'dismissed'>
}): SpeakerSuggestion[] {
  const out: SpeakerSuggestion[] = []
  const seen = new Set<string>()
  for (const row of input.speakers || []) {
    const label = (row.label || '').trim()
    const name = (row.name || '').trim()
    if (!label || !name) continue
    const speakerId = Object.keys(input.speakerNames).find((id) => input.speakerNames[id] === label)
    if (!speakerId) continue
    if (input.decided[speakerId]) continue
    if (seen.has(speakerId)) continue
    const taken = Object.entries(input.speakerNames).some(([id, value]) => id !== speakerId && value === name)
    if (taken) continue
    seen.add(speakerId)
    const evidence = (row.evidence || '').trim()
    out.push(evidence ? { speakerId, name, evidence } : { speakerId, name })
  }
  return out
}
