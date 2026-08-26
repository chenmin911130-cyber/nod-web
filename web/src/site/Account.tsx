import { useEffect, useState, type FormEvent } from 'react'
import { api, fetchMe, logout, type Me } from '../auth'
import './Site.css'
import NodMark from './NodMark'

type SessionRow = {
  id: string
  mode: string
  title: string
  started_at: string | null
  stt_seconds: number
  llm_tokens: number
  cost_usd: number
  items: Array<{ kind: string; text: string }>
  files?: Array<{ kind: string; name: string; href: string }>
}

function pct(used: number, limit: number) {
  if (!limit) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

function fmtMin(sec: number) {
  return `${Math.max(0, Math.round((sec / 60) * 10) / 10)} min`
}

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [feedback, setFeedback] = useState('')
  const paid = new URLSearchParams(location.search).get('paid')

  useEffect(() => {
    document.title = 'Account · Nod'
    void (async () => {
      const user = await fetchMe()
      if (!user) {
        location.href = '/login?next=/account'
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
        <div className="site-wrap">Loading account…</div>
      </div>
    )
  }

  const u = me.usage
  const checkout = async () => {
    setErr('')
    try {
      const out = await api<{ url: string }>('/api/billing/checkout', { method: 'POST' })
      location.href = out.url
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Checkout failed')
    }
  }

  const portal = async () => {
    try {
      const out = await api<{ url: string }>('/api/billing/portal', { method: 'POST' })
      location.href = out.url
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Billing portal failed')
    }
  }

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
    location.href = '/'
  }

  return (
    <div className="nod-site-page">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="/">
            <NodMark />
            Nod
          </a>
          <div className="header-actions">
            <a className="button button-ghost" href="/app">
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
                      location.href = '/'
                    })
                    return
                  }
                  location.href = '/?signout=1'
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
            Plan: <b>{me.plan_name}</b> · {me.subscription_status}
            {paid === '1' ? ' · Payment received. Refresh if the plan has not updated yet.' : ''}
            {me.quota_disabled || u.quota_disabled
              ? ' · Testing: transcription, generation, and daily caps are not enforced unless an admin sets a monthly time cap.'
              : u.stt_limit_seconds != null
                ? ` · ${fmtMin(u.stt_limit)} of live transcription this month. Listening pauses when the cap is reached.`
                : me.plan === 'pro'
                ? ' · Cancel anytime from Manage billing. Hitting a cap pauses listening and generation until the month resets.'
                : ' · Trial needs no card. Generation tokens are limited. Upgrade anytime — cancel Pro from this page after checkout.'}
          </p>
          <div className="quota-grid">
            <div className="quota-card">
              <span>Transcription left</span>
              <b>{fmtMin(Math.max(0, u.stt_limit - u.stt_seconds))}</b>
              <span>
                {fmtMin(u.stt_seconds)} / {fmtMin(u.stt_limit)} this month
              </span>
              <div className="bar">
                <i style={{ width: `${pct(u.stt_seconds, u.stt_limit)}%` }} />
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
            <div className="quota-card">
              <span>Estimated model cost today</span>
              <b>${u.daily_cost_usd.toFixed(3)}</b>
              <span>Daily cap ${u.daily_cost_limit} · sessions {u.sessions}/{u.session_limit}</span>
              <div className="bar">
                <i style={{ width: `${pct(u.daily_cost_usd, u.daily_cost_limit)}%` }} />
              </div>
            </div>
          </div>
          <div className="hero-actions">
            {me.quota_disabled || u.quota_disabled || !me.stripe_enabled ? (
              <a className="button button-primary" href="/app">
                Open workspace
              </a>
            ) : me.plan === 'pro' ? (
              <button className="button button-primary" type="button" onClick={() => void portal()}>
                Manage billing
              </button>
            ) : (
              <button className="button button-primary" type="button" onClick={() => void checkout()}>
                Upgrade to Pro · USD $12 / month
              </button>
            )}
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
          <p>Transcripts and answers stay on your account. If cloud audio storage is on, long sessions are saved as 30-minute WAV parts, up to 8 hours.</p>
          <div className="history-list">
            {sessions.length === 0 && <p>No sessions yet. Open the workspace to start one.</p>}
            {sessions.map((s) => (
              <article key={s.id} className="history-item">
                <small>
                  {s.mode} · {s.started_at ? new Date(s.started_at).toLocaleString() : ''} · {fmtMin(s.stt_seconds)} · $
                  {s.cost_usd.toFixed(4)}
                </small>
                <h3>{s.title || 'Session'}</h3>
                <p>{s.items.slice(0, 2).map((i) => i.text).join(' / ').slice(0, 220)}</p>
                {s.files && s.files.length > 0 && (
                  <p>
                    {s.files.map((file) => (
                      <a key={file.href} href={file.href} style={{ marginRight: 12 }}>
                        {file.name}
                      </a>
                    ))}
                  </p>
                )}
              </article>
            ))}
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
