import { useEffect, useState } from 'react'
import { api } from '../auth'
import { saveSessionToFiles } from '../sessionExport'
import { copyText, historySessionMatches, modeOf, sceneOf } from '../historyRestore'

export type HistoryItem = { kind: string; text: string; at?: string | null; qid?: string }
export type HistoryFile = { kind: string; name: string; href: string }
export type HistorySession = {
  id: string
  mode: string
  scene?: string
  title: string
  started_at: string | null
  ended_at?: string | null
  stt_seconds: number
  items: HistoryItem[]
  copy_text?: string
  files?: HistoryFile[]
}

function mins(sec: number) {
  return `${Math.max(0, Math.round((sec / 60) * 10) / 10)} min`
}

export default function HistoryPane({
  open,
  onClose,
  onRestore,
}: {
  open: boolean
  onClose: () => void
  onRestore?: (session: HistorySession) => void
}) {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState('')
  const [busyId, setBusyId] = useState('')
  const [pdfId, setPdfId] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    setLoading(true)
    setErr('')
    void api<{ sessions: HistorySession[] }>('/api/account/history')
      .then((out) => setSessions(out.sessions || []))
      .catch((ex: Error) => setErr(ex.message))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const copySession = async (session: HistorySession) => {
    const ok = await copyText(session.copy_text || session.items.map((i) => i.text).join('\n'))
    setCopied(ok ? session.id : '')
    window.setTimeout(() => setCopied(''), 1600)
  }

  const exportFiles = async (session: HistorySession) => {
    setPdfId(session.id)
    setErr('')
    try {
      await saveSessionToFiles(session)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not save to Files')
    } finally {
      setPdfId('')
    }
  }

  const deleteSession = async (session: HistorySession) => {
    if (!window.confirm(`Delete this ${sceneOf(session)} session? This cannot be undone.`)) return
    setBusyId(session.id)
    setErr('')
    try {
      await api(`/api/account/history/${session.id}`, { method: 'DELETE' })
      setSessions((rows) => rows.filter((row) => row.id !== session.id))
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not delete session')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="hist-root" role="dialog" aria-label="Session history">
      <button type="button" className="hist-backdrop" aria-label="Close history" onClick={onClose} />
      <aside className="hist-panel">
        <header className="hist-head">
          <div>
            <div className="hist-kicker">History</div>
            <h2>Your sessions</h2>
            <p className="hist-meta">Click a session to open it in the workspace. Sessions stay for 30 days. Copy, Save to Files, or delete without opening.</p>
          </div>
          <button type="button" className="hist-close" onClick={onClose}>
            Close
          </button>
        </header>
        {loading && <p className="hist-empty">Loading sessions…</p>}
        {err && <p className="hist-err">{err}</p>}
        {!loading && !err && sessions.length === 0 && (
          <p className="hist-empty">No sessions yet. Save a Meeting or Lecture after it ends. History keeps each session for 30 days.</p>
        )}
        {sessions.length > 0 && (
          <label className="hist-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search meetings, lectures, notes…"
              aria-label="Search history"
            />
          </label>
        )}
        {!loading && !err && sessions.length > 0 && sessions.filter((s) => historySessionMatches(s, query)).length === 0 && (
          <p className="hist-empty">No sessions match that search.</p>
        )}
        <div className="hist-body hist-body-pick">
          <ul className="hist-list">
            {sessions.filter((s) => historySessionMatches(s, query)).map((s) => (
              <li key={s.id} className="hist-row">
                <button
                  type="button"
                  className="hist-pick"
                  disabled={busyId === s.id}
                  onClick={() => onRestore?.(s)}
                >
                  <b>{s.title || 'Session'}</b>
                  <span>
                    {sceneOf(s)} · {modeOf(s)} · {s.started_at ? new Date(s.started_at).toLocaleString() : ''}
                    {` · ${mins(s.stt_seconds)}`}
                  </span>
                </button>
                <div className="hist-row-actions">
                  <button type="button" onClick={() => void copySession(s)}>
                    {copied === s.id ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    disabled={pdfId === s.id}
                    onClick={() => void exportFiles(s)}
                  >
                    {pdfId === s.id ? 'Saving…' : 'Save to Files'}
                  </button>
                  <button
                    type="button"
                    className="hist-del"
                    disabled={busyId === s.id}
                    onClick={() => void deleteSession(s)}
                  >
                    {busyId === s.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
                {(s.files || []).some((file) => file.kind === 'audio') && (
                  <p className="hist-files">Recording included when you Save to Files.</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  )
}
