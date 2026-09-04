import { useEffect, useState } from 'react'
import { api, fetchMe, logout, type Me } from '../auth'
import { readNativeAppBuild } from '../native'
import { PRODUCT_NAME } from '../brand'
import { IPHONE_COPY } from '../iphoneCopy'

type SessionRow = {
  id: string
  mode: string
  title: string
  started_at: string | null
  ended_at?: string | null
  stt_seconds: number
  llm_tokens: number
  cost_usd: number
  items: Array<{ kind: string; text: string }>
  copy_text?: string
  scene?: string
  files?: Array<{ kind: string; name: string; href: string }>
}

function pct(used: number, limit: number) {
  if (!limit) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

function fmtMin(sec: number) {
  return `${Math.max(0, Math.round((sec / 60) * 10) / 10)} min`
}

function fmtHours(sec: number) {
  return `${Math.max(0, Math.round((sec / 3600) * 10) / 10)} h`
}

/**
 * In-app Account panel (workspace overlay, like HistoryPane).
 * Shows the signed-in user, usage/quota, installed app version, and
 * account actions. Does NOT navigate to the site — it renders inline
 * so the phone never flashes / redirects.
 */
export default function AccountPane({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [me, setMe] = useState<Me | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [feedback, setFeedback] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const [appBuild, setAppBuild] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      setErr('')
      setMsg('')
      setFeedback('')
      setOpenId(null)
      return
    }
    setLoading(true)
    void readNativeAppBuild().then(setAppBuild)
    void (async () => {
      const user = await fetchMe()
      if (user) {
        setMe(user)
        try {
          const hist = await api<{ sessions: SessionRow[] }>('/api/account/history')
          setSessions(hist.sessions || [])
        } catch {
          /* ignore history errors */
        }
      }
      setLoading(false)
    })()
  }, [open])

  if (!open) return null

  if (!me) {
    return (
      <div className="hist-root hist-page" role="dialog" aria-label={IPHONE_COPY.accountTitle}>
        <aside className="hist-panel">
          <header className="hist-head">
            <h2>{IPHONE_COPY.accountTitle}</h2>
            <button type="button" className="hist-close" onClick={onClose}>
              {IPHONE_COPY.histDone}
            </button>
          </header>
          <p className="hist-empty">{loading ? 'Loading account…' : 'Could not load account. Sign in on the web or reopen the app.'}</p>
          {appBuild ? <p className="hist-empty">Installed {appBuild}</p> : null}
        </aside>
      </div>
    )
  }

  const u = me.usage

  const sendFeedback = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ email: me.email, message: feedback }) })
      setFeedback('')
      setMsg('Thanks — we have the note.')
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not send feedback')
    }
  }

  const wipe = async () => {
    if (!window.confirm('Delete your account, history, and remaining quota? This cannot be undone.')) return
    try {
      await api('/api/account', { method: 'DELETE' })
      await logout()
      onClose()
      window.location.reload()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not delete account')
    }
  }

  return (
    <div className="hist-root hist-page" role="dialog" aria-label={IPHONE_COPY.accountTitle}>
      <aside className="hist-panel hist-account-panel">
        <header className="hist-head">
          <h2>{IPHONE_COPY.accountTitle}</h2>
          <button type="button" className="hist-close" onClick={onClose}>
            {IPHONE_COPY.histDone}
          </button>
        </header>

        <div className="hist-body">
          <div className="account-user">
            <b>{me.name || me.email}</b>
            <small>{me.email}</small>
          </div>

          <div className="quota-grid">
            <div className="quota-card">
              <span>Listening left today</span>
              <b>{fmtHours(Math.max(0, (u.daily_stt_limit || 2 * 3600) - (u.daily_stt_seconds || 0)))}</b>
              <span>
                {fmtHours(u.daily_stt_seconds || 0)} / {fmtHours(u.daily_stt_limit || 2 * 3600)} today
              </span>
              <div className="bar">
                <i style={{ width: `${pct(u.daily_stt_seconds || 0, u.daily_stt_limit || 2 * 3600)}%` }} />
              </div>
            </div>
            <div className="quota-card">
              <span>Generation tokens left</span>
              <b>{Math.max(0, u.llm_limit - u.llm_tokens).toLocaleString()}</b>
              <span>
                {u.llm_tokens.toLocaleString()} / {u.llm_limit.toLocaleString()}
              </span>
              <div className="bar">
                <i style={{ width: `${pct(u.llm_tokens, u.llm_limit)}%` }} />
              </div>
            </div>
            {appBuild ? (
              <div className="quota-card">
                <span>Installed app</span>
                <b>{appBuild}</b>
              </div>
            ) : null}
          </div>

          {err && <p className="hist-err">{err}</p>}
          {msg && <p className="hist-ok">{msg}</p>}

          <h3 className="hist-section">Your sessions</h3>
          {sessions.length === 0 && <p className="hist-empty">No sessions yet. Save a meeting to see it here.</p>}
          <div className="hist-list">
            {sessions.map((s) => {
              const openRow = openId === s.id
              return (
                <article key={s.id} className="history-item">
                  <button type="button" className="history-open" onClick={() => setOpenId(openRow ? null : s.id)}>
                    <small>
                      {s.mode} · {s.started_at ? new Date(s.started_at).toLocaleString() : ''} · {fmtMin(s.stt_seconds)}
                      {s.ended_at ? '' : ' · in progress'}
                    </small>
                    <h3>{s.title || 'Session'}</h3>
                    {!openRow && <p>{s.items.slice(0, 2).map((i) => i.text).join(' / ').slice(0, 220)}</p>}
                  </button>
                  {openRow && (
                    <div className="history-detail">
                      <p className="history-actions">
                        <button
                          type="button"
                          className="button button-ghost"
                          onClick={() => {
                            setCopied(s.id)
                            try {
                              navigator.clipboard?.writeText(s.copy_text || s.items.map((i) => i.text).join('\n'))
                            } catch {
                              /* ignore */
                            }
                            window.setTimeout(() => setCopied(''), 1600)
                          }}
                        >
                          {copied === s.id ? 'Copied' : 'Copy session'}
                        </button>
                        <button type="button" className="button button-ghost" onClick={() => setOpenId(null)}>
                          Close
                        </button>
                      </p>
                      {s.items.length === 0 && <p>No transcript or answers saved in this session.</p>}
                      {s.items.map((item, i) => (
                        <p key={`${item.kind}-${i}`}>
                          <small>{item.kind}</small>
                          <br />
                          {item.text}
                        </p>
                      ))}
                    </div>
                  )}
                </article>
              )
            })}
          </div>

          <h3 className="hist-section">Send feedback</h3>
          <form className="site-form" onSubmit={sendFeedback}>
            <label>
              What should we fix or add?
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} required minLength={4} />
            </label>
            <button className="button button-primary" type="submit">
              Send
            </button>
          </form>

          <div className="danger-zone">
            <p>Delete account and all stored history. Provider copies already processed cannot be recalled from here.</p>
            <button className="button button-ghost" type="button" onClick={() => void wipe()}>
              Delete my data
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

export { PRODUCT_NAME }
