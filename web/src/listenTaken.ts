/** Same copy the server emits on `{ type: 'listen_taken' }`. */
export const LISTEN_TAKEN_TEXT =
  'Another device started listening. Tap Start Listening to take it back.'

/** Clear listenWanted so the stolen device leaves Listening and does not reconnect-start. */
export function shouldReleaseListen(e: { type: string; text?: string }): boolean {
  if (e.type === 'listen_taken' || e.type === 'quota_exceeded') return true
  if (e.type !== 'error') return false
  const text = e.text || ''
  return (
    text.includes('Transcription connection lost') ||
    text.includes('Another device started listening')
  )
}
