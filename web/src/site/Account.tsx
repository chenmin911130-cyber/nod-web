import { useEffect, useState, type FormEvent } from 'react'
import { api, fetchMe, logout, type Me } from '../auth'
import { nativeGo, readNativeAppBuild } from '../native'
import { downloadHistoryPdf } from '../historyPdf'
import { copyText } from '../historyRestore'
import './Site.css'
import { PRODUCT_NAME } from '../brand'
import NodMark from './NodMark'

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

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [feedback, setFeedback] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const [appBuild, setAppBuild] = useState('')

  const copySession = async (session: SessionRow, key = session.id) => {
    const ok = await copyText(session.copy_text || session.items.map((item) => item.text).join('\n'))
    setCopied(ok ? key : '')
    window.setTimeout(() => setCopied(''), 1600)
  }

  useEffect(() => {
    document.title = `Account · ${PRODUCT_NAME}`
    void readNativeAppBuild().then(setAppBuild)
    void (async () => {
      const user = await fetchMe()
      if (!user) {
        nativeGo('/login?next=/account')
        return
      }
      setMe(user)
      try {
        const hist = await api<{ sessions: SessionRow[] }>('/api/account/history')
        setSessions(hist.sessions || [])
      } catch {
        /* ignore */
      }
    })()
  }, [])

  if (!me) {
    return (
      <div className="nod-site-page">
        <div className="site-wrap">
          Loading account…
          {appBuild ? <p>Installed {appBuild}</p> : null}
        </div>
      </div>
    )
  }

  const u = me.usage

  const sendFeedback = async (e: FormEvent) => {
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
    if (!confirm('Delete your account, history, and remaining quota? This cannot be undone.')) return
    await api('/api/account', { method: 'DELETE' })
    logout()
    nativeGo('/login')
  }

  return (
    <div className="nod-site-page">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="/">
            <NodMark />
            {PRODUCT_NAME}
          </a>
          <div className="header-actions">
            <a className="button button-cyan header-cta" href="/app">
              Workspace
            </a>
            <button
              className="button button-ghost"
              type="button"
              onClick={() => {
                void logout().finally(() => {
                  const clerk = (window as unknown as { Clerk?: { signOut?: () => Promise<unknown> } }).Clerk
                  if (clerk?.signOut) {
                    void clerk.signOut().finally(() => {
                      nativeGo('/login')
                    })
                    return
                  }
                  nativeGo('/login')
                })
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <div className="site-wrap wide">
        <div className="site-card">
          <div className="eyebrow">ACCOUNT</div>
          <h1>{me.name || me.email}</h1>
          <p>
            Free public testing · no subscription
            {me.quota_disabled || u.quota_disabled
              ? ' · Testing: transcription, generation, and daily caps are not enforced unless an admin sets a monthly time cap.'
              : ` · ${fmtHours(u.daily_stt_limit || 2 * 3600)} of live transcription each day. Listening pauses when the daily cap is reached.`}
          </p>
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
          <div className="hero-actions">
            <a className="button button-primary" href="/app">
              Open workspace
            </a>
            <a className="button button-ghost" href="/privacy">
              Privacy
            </a>
          </div>
          {err && <p className="site-err">{err}</p>}
          {msg && <p className="site-ok">{msg}</p>}
        </div>

        <div className="site-card" style={{ marginTop: 18 }}>
          <div className="eyebrow">HISTORY</div>
          <h1>Your sessions</h1>
          <p>Each listen session is saved here for 30 days. Open one to read the transcript, answers, and any audio files.</p>
          <div className="history-list">
            {sessions.length === 0 && <p>No sessions yet. Open the workspace to start one.</p>}
            {sessions.map((s) => {
              const open = openId === s.id
              return (
                <article key={s.id} className="history-item">
                  <button type="button" className="history-open" onClick={() => setOpenId(open ? null : s.id)}>
                    <small>
                      {s.mode} · {s.started_at ? new Date(s.started_at).toLocaleString() : ''} · {fmtMin(s.stt_seconds)}
                      {s.ended_at ? '' : ' · in progress'}
                    </small>
                    <h3>{s.title || 'Session'}</h3>
                    {!open && <p>{s.items.slice(0, 2).map((i) => i.text).join(' / ').slice(0, 220)}</p>}
                  </button>
                  {open && (
                    <div className="history-detail">
                      <p className="history-actions">
                        <button
                          type="button"
                          className="button button-ghost"
                          onClick={() => void copySession(s)}
                        >
                          {copied === s.id ? 'Copied' : 'Copy session'}
                        </button>
                        <button
                          type="button"
                          className="button button-ghost"
                          onClick={() => void downloadHistoryPdf(s).catch((ex: Error) => setErr(ex.message))}
                        >
                          {(s.files || []).find((file) => file.kind === 'pdf')?.name || 'Download PDF'}
                        </button>
                        <button
                          type="button"
                          className="button button-ghost"
                          onClick={() => {
                            if (!confirm(`Delete this ${s.mode} session? This cannot be undone.`)) return
                            void api(`/api/account/history/${s.id}`, { method: 'DELETE' })
                              .then(() => {
                                setSessions((rows) => rows.filter((row) => row.id !== s.id))
                                setOpenId(null)
                                setMsg('Session deleted')
                              })
                              .catch((ex: Error) => setErr(ex.message))
                          }}
                        >
                          Delete
                        </button>
                      </p>
                      {s.files && s.files.some((file) => file.kind === 'audio') && (
                        <p>
                          {s.files.filter((file) => file.kind === 'audio').map((file) => (
                            <a key={file.href} href={file.href} style={{ marginRight: 12 }}>
                              {file.name}
                            </a>
                          ))}
                        </p>
                      )}
                      {s.items.length === 0 && <p>No transcript or answers saved in this session.</p>}
                      {s.items.map((item, i) => (
                        <p key={`${item.kind}-${i}`}>
                          <small>{item.kind}</small>
                          <button
                            type="button"
                            className="history-copy-one"
                            onClick={() => void copyText(item.text).then((ok) => ok && setCopied(`${s.id}-${i}`))}
                          >
                            {copied === `${s.id}-${i}` ? 'Copied' : 'Copy'}
                          </button>
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
        </div>

        <div className="site-card" style={{ marginTop: 18 }}>
          <div className="eyebrow">SUPPORT</div>
          <h1>Send feedback</h1>
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
      </div>
    </div>
  )
}
