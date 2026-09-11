/**
 * #182: the identity of ONE user submit action.
 *
 * The server's search gate dedupes on this id, so it has to be generated at the
 * moment the user submits — before any await, and reused if the same frame is
 * delivered twice — and it has to be NEW for every genuine question, even when the
 * text is identical to an earlier one. A timestamp plus randomness is enough: the
 * id only has to be unique, and it never leaves the client/server pair.
 */
export function newSubmitId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      /* fall through to the manual form */
    }
  }
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
