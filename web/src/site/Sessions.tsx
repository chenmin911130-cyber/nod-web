import { useEffect, useMemo, useState } from 'react'
import { api, fetchMe } from '../auth'
import { LISTENING_MODES } from '../listening'
import './Site.css'
import NodMark from './NodMark'

type SessionRow = {
  id: string
  mode: string
  listening_mode?: string
  title: string
  started_at: string | null
  stt_seconds: number
  llm_tokens: number
  items: Array<{ kind: string; text: string }>
}

const FILTERS = [{ id: 'all', label: 'All' }, ...LISTENING_MODES, { id: 'interview', label: 'Interview' }, { id: 'translate', label: 'Translate' }]

function modeLabel(mode: string) {
  return LISTENING_MODES.find((m) => m.id === mode)?.label || mode.replace(/_/g, ' ')
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState('')
  const [segments, setSegments] = useState<Array<{ start_time: string; original_text: string }>>([])

  useEffect(() => {
    document.title = 'Sessions · Nod'
    void (async () => {
      const user = await fetchMe()
      if (!user) {
        location.href = '/login?next=/sessions'
        return
      }
      try {
        const hist = await api<{ sessions: SessionRow[] }>('/api/account/history')
        setSessions(hist.sessions || [])
      } catch {
        /* ignore */
      }
    })()
  }, [])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return sessions.filter((s) => {
      const key = (s.listening_mode || s.mode || '').toLowerCase()
      if (filter !== 'all' && key !== filter && s.mode !== filter) return false
      if (!needle) return true
      const hay = `${s.title} ${s.items.map((i) => i.text).join(' ')}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [sessions, filter, q])

  return (
    <div className="nod-site-page">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="/">
            <NodMark />
            Nod
          </a>
          <div className="header-actions">
            <a className="button button-ghost" href="/account">
              Account
            </a>
            <a className="button button-primary" href="/app">
              Start listening
            </a>
          </div>
        </div>
      </header>
      <div className="site-wrap wide">
        <div className="site-card">
          <div className="eyebrow">SESSIONS</div>
          <h1>Your listening history</h1>
          <p>Search and filter what you have already heard. Open a session to reread the transcript and notes.</p>
          <input
            className="session-search"
            placeholder="Search sessions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="session-filters">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`ask-chip${filter === f.id ? ' on' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="history-list">
            {visible.length === 0 && <p>No sessions yet. Start listening to create one.</p>}
            {visible.map((s) => (
              <article key={s.id} className="history-item">
                <small>
                  {modeLabel(s.listening_mode || s.mode)} · {s.started_at ? new Date(s.started_at).toLocaleString() : ''} ·{' '}
                  {Math.max(0, Math.round(s.stt_seconds / 6) / 10)} min
                </small>
                <h3>{s.title || 'Session'}</h3>
                <p>{s.items.slice(0, 2).map((i) => i.text).join(' / ').slice(0, 220)}</p>
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => {
                    if (openId === s.id) {
                      setOpenId('')
                      return
                    }
                    setOpenId(s.id)
                    void api<{ segments?: Array<{ start_time: string; original_text: string }> }>(`/api/account/history/${s.id}`)
                      .then((out) => setSegments(out.segments || []))
                      .catch(() => setSegments([]))
                  }}
                >
                  {openId === s.id ? 'Close' : 'Open'}
                </button>
                {openId === s.id && (
                  <div className="session-body">
                    {segments.length > 0
                      ? segments.map((seg, idx) => (
                          <p key={`${s.id}-seg-${idx}`}>
                            <b>{seg.start_time || 'line'}</b> {seg.original_text}
                          </p>
                        ))
                      : s.items.map((item, idx) => (
                          <p key={`${s.id}-${idx}`}>
                            <b>{item.kind}</b> {item.text}
                          </p>
                        ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
