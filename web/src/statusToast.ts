/** Status strings that must not float over the phone title bar. */
export function statusIsAmbient(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/^(Starting|Ready|Listening|Recording|Calibrat|Transcrib|Checking|Generating|Thinking)/i.test(t)) return true
  if (t.startsWith('I caught part')) return true
  if (t.startsWith('Speech recognition ·')) return true
  if (t.startsWith('Mode ·')) return true
  if (/^Opened .+ session$/.test(t)) return true
  return false
}
