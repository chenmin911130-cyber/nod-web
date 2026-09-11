import { useEffect, useState, type FormEvent } from 'react'
import '../landing/Landing.css'
import './Admin.css'
import { PRODUCT_NAME } from '../brand'
import { applySeo } from './track'
import { SITE_ORIGIN, siteUrl } from '../siteOrigin'
import NodMark from './NodMark'

type Tab = 'overview' | 'users' | 'sessions' | 'feedback' | 'settings'

type Overview = {
  users: number
  signups_today: number
  no_consent: number
  open_sessions: number
  live_ws: number
  live_listening: number
  live_generating: number
  errors_1h: number
  quota_blocks_1h: number
  ws_rejected_1h: number
  feedback: number
  stt_seconds_today: number
  cost_usd_today: number
  days: Array<{ day: string; cost_usd: number; stt_seconds: number; llm_tokens: number }>
  quota_disabled: boolean
  global_daily_budget_usd: number
}

type AdminUser = {
  id: string
  email: string
  name: string
  plan: string
  subscription_status: string
  consent: boolean
  google: boolean
  created_at: string | null
  stt_seconds: number
  llm_tokens: number
  cost_usd: number
  sessions: number
  last_seen: string | null
  stt_limit_seconds: number | null
  usage?: {
    stt_seconds: number
    stt_limit: number
    stt_limit_seconds: number | null
    quota_disabled: boolean
  }
  history?: Array<{
    id: string
    mode: string
    title: string
    started_at: string | null
    stt_seconds: number
    llm_tokens: number
    cost_usd: number
  }>
}

type SessionRow = {
  id: string
  user_id: string
  email: string
  mode: string
  title: string
  started_at: string | null
  ended_at: string | null
  stt_seconds: number
  llm_tokens: number
  cost_usd: number
  discarded: boolean
}

type FeedbackRow = {
  id: string
  email: string
  message: string
  created_at: string | null
}

const TOKEN_KEY = 'nod_admin'

function mins(sec: number) {
  return `${Math.round((sec / 60) * 10) / 10} min`
}

function capLabel(sec: number | null | undefined) {
  if (sec == null) return 'Unlimited'
  return mins(sec)
}

const PRESETS = [20, 60, 120, 480]

async function adminApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = sessionStorage.getItem(TOKEN_KEY) || ''
  if (token) headers.set('X-Admin-Token', token)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...init, headers, credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as T & { detail?: unknown }
  if (!res.ok) {
    const detail = data?.detail
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`)
  }
  return data
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [authed, setAuthed] = useState(false)
  const [token, setToken] = useState('')
  const [err, setErr] = useState('')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [feedback, setFeedback] = useState<FeedbackRow[]>([])
  const [backupMsg, setBackupMsg] = useState('')
  const [minutes, setMinutes] = useState('')
  const [quotaMsg, setQuotaMsg] = useState('')

  const load = async (which: Tab = tab) => {
    if (which === 'overview') {
      const out = await adminApi<Overview & { ok: boolean }>('/api/admin/overview')
      setOverview(out)
    } else if (which === 'users') {
      const out = await adminApi<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`)
      setUsers(out.users || [])
    } else if (which === 'sessions') {
      const out = await adminApi<{ sessions: SessionRow[] }>('/api/admin/sessions')
      setSessions(out.sessions || [])
    } else if (which === 'feedback') {
      const out = await adminApi<{ feedback: FeedbackRow[] }>('/api/admin/feedback')
      setFeedback(out.feedback || [])
    } else if (which === 'settings') {
      const out = await adminApi<Overview & { ok: boolean }>('/api/admin/overview')
      setOverview(out)
    }
  }

  useEffect(() => {
    applySeo({
      title: `Admin · ${PRODUCT_NAME}`,
      description: 'Nodpilot admin.',
      url: siteUrl('/admin'),
      lang: 'en',
      image: `${SITE_ORIGIN}/og.png`,
      robots: 'noindex,nofollow',
    })
    void adminApi('/api/admin/overview')
      .then(() => {
        setAuthed(true)
      })
      .catch(() => setAuthed(false))
  }, [])

  useEffect(() => {
    if (!authed) return
    void load(tab).catch((ex: Error) => setErr(ex.message))
  }, [authed, tab])

  useEffect(() => {
    if (!authed || tab !== 'overview') return
    const tick = window.setInterval(() => {
      void load('overview').catch((ex: Error) => setErr(ex.message))
    }, 15_000)
    return () => window.clearInterval(tick)
  }, [authed, tab])

  const signIn = async (e: FormEvent) => {
    e.preventDefault()
    setErr('')
    try {
      await adminApi('/api/admin/login', { method: 'POST', body: JSON.stringify({ token }) })
      sessionStorage.setItem(TOKEN_KEY, token.trim())
      setAuthed(true)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Login failed')
    }
  }

  const openUser = async (id: string) => {
    const out = await adminApi<{ user: AdminUser }>(`/api/admin/users/${id}`)
    setSelected(out.user)
    const cap = out.user.stt_limit_seconds
    setMinutes(cap == null ? '' : String(Math.round((cap / 60) * 10) / 10))
    setQuotaMsg('')
  }

  const saveQuota = async (value: number | null) => {
    if (!selected) return
    setQuotaMsg('')
    const out = await adminApi<{ user: AdminUser }>(`/api/admin/users/${selected.id}/quota`, {
      method: 'PATCH',
      body: JSON.stringify({ minutes: value }),
    })
    setSelected(out.user)
    setUsers((list) => list.map((u) => (u.id === out.user.id ? { ...u, ...out.user } : u)))
    const cap = out.user.stt_limit_seconds
    setMinutes(cap == null ? '' : String(Math.round((cap / 60) * 10) / 10))
    setQuotaMsg(cap == null ? 'Unlimited this month' : `${capLabel(cap)} per month`)
  }

  const removeUser = async (id: string) => {
    if (!confirm('Delete this test account and its history?')) return
    await adminApi(`/api/admin/users/${id}`, { method: 'DELETE' })
    setSelected(null)
    await load('users')
  }

  const runBackup = async () => {
    setBackupMsg('')
    const out = await adminApi<{ path?: string }>('/api/admin/backup', { method: 'POST' })
    setBackupMsg(out.path ? `Saved ${out.path}` : 'Backup finished')
  }

  if (!authed) {
    return (
      <div className="admin-shell">
        <form className="admin-login" onSubmit={signIn}>
          <div className="brand">
            <NodMark size={28} />
            {PRODUCT_NAME}
          </div>
          <div className="eyebrow">NODPILOT ADMIN</div>
          <h1>Test console</h1>
          <p>Enter the admin token to see customer data.</p>
          <label>
            Admin token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" />
          </label>
          {err && <div className="site-err">{err}</div>}
          <button className="button button-primary" type="submit">
            Open console
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="admin-shell">
      <aside className="admin-side">
        <div className="brand">
          <NodMark />
          {PRODUCT_NAME}
        </div>
        <div className="nav-label">OPERATIONS</div>
        {(['overview', 'users', 'sessions', 'feedback'] as const).map((id) => (
          <button key={id} className={tab === id ? 'on' : ''} type="button" onClick={() => setTab(id)}>
            {id === 'overview' ? 'Overview' : id === 'users' ? 'Users' : id === 'sessions' ? 'Sessions' : 'Feedback'}
          </button>
        ))}
        <div className="nav-label">SYSTEM</div>
        <button className={tab === 'settings' ? 'on' : ''} type="button" onClick={() => setTab('settings')}>
          Settings
        </button>
        <button
          type="button"
          onClick={() => {
            sessionStorage.removeItem(TOKEN_KEY)
            void adminApi('/api/admin/logout', { method: 'POST' }).finally(() => {
              setAuthed(false)
              setToken('')
            })
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="admin-main">
        {err && <div className="site-err">{err}</div>}
        {tab === 'overview' && overview && (
          <>
            <div className="admin-top">
              <div>
                <h1>What happened today</h1>
                <p className="sub">Testing is free. Limits are off. This page only records usage.</p>
              </div>
              <span className="tag test">Quota off</span>
            </div>
            <div className="kpis">
              <div className="card">
                <small>Users</small>
                <b>{overview.users}</b>
                <span className="up">+{overview.signups_today} today</span>
              </div>
              <div className="card">
                <small>STT today</small>
                <b>{mins(overview.stt_seconds_today)}</b>
                <span className="up">no cap</span>
              </div>
              <div className="card">
                <small>Est. cost today</small>
                <b>${overview.cost_usd_today.toFixed(2)}</b>
                <span className="warn">budget ${overview.global_daily_budget_usd}</span>
              </div>
              <div className="card">
                <small>Live now</small>
                <b>{overview.live_ws ?? 0}</b>
                <span className="up">
                  {overview.live_listening ?? 0} listening · {overview.live_generating ?? 0} generating
                </span>
              </div>
              <div className="card">
                <small>Errors · 1h</small>
                <b>{overview.errors_1h ?? 0}</b>
                <span className={overview.ws_rejected_1h ? 'warn' : 'up'}>
                  {overview.ws_rejected_1h ?? 0} ws rejected
                </span>
              </div>
              <div className="card">
                <small>Quota blocks · 1h</small>
                <b>{overview.quota_blocks_1h ?? 0}</b>
                <span className="up">billing open {overview.open_sessions}</span>
              </div>
            </div>
            <div className="grid-2">
              <div className="card">
                <small>Last 14 days · estimated cost</small>
                <div className="bars">
                  {(overview.days || []).slice().reverse().map((d) => {
                    const max = Math.max(...overview.days.map((x) => x.cost_usd), 0.01)
                    return (
                      <div className="bar-row" key={d.day}>
                        <span>{d.day.slice(5)}</span>
                        <div className="bar">
                          <i style={{ width: `${Math.round((d.cost_usd / max) * 100)}%` }} />
                        </div>
                        <span>${d.cost_usd.toFixed(2)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="card">
                <small>Needs attention</small>
                <p>
                  Mic consent missing: {overview.no_consent}
                  <br />
                  Feedback waiting: {overview.feedback}
                </p>
              </div>
            </div>
          </>
        )}

        {tab === 'users' && (
          <>
            <div className="admin-top">
              <div>
                <h1>Users</h1>
                <p className="sub">Default is unlimited. Open a user to set monthly transcription minutes.</p>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void load('users')
                }}
              >
                <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email / name" />
              </form>
            </div>
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Plan</th>
                    <th>Used</th>
                    <th>Cap</th>
                    <th>Tokens</th>
                    <th>Consent</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.email}
                        <br />
                        <small>{u.last_seen ? new Date(u.last_seen).toLocaleString() : 'No session yet'}</small>
                      </td>
                      <td>
                        <span className="tag trial">Free test</span>
                      </td>
                      <td>{mins(u.stt_seconds)}</td>
                      <td>{capLabel(u.stt_limit_seconds)}</td>
                      <td>{u.llm_tokens.toLocaleString()}</td>
                      <td>{u.consent ? 'Yes' : <span className="tag off">No</span>}</td>
                      <td>
                        <button className="ghost" type="button" onClick={() => void openUser(u.id)}>
                          Quota
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {users.length === 0 && <p className="sub">No users yet.</p>}
            </div>
            {selected && (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="admin-top">
                  <div>
                    <h1 style={{ fontSize: 22 }}>{selected.email}</h1>
                    <p className="sub">
                      {selected.name || 'No name'} · {selected.google ? 'Google' : 'Email'} · created{' '}
                      {selected.created_at ? new Date(selected.created_at).toLocaleString() : '—'}
                    </p>
                  </div>
                  <button className="ghost" type="button" onClick={() => void removeUser(selected.id)}>
                    Delete test account
                  </button>
                </div>
                <div className="quota-box">
                  <b>Monthly transcription</b>
                  <p className="sub">
                    Used this month:{' '}
                    {mins(selected.usage?.stt_seconds ?? selected.stt_seconds)}
                    {selected.stt_limit_seconds == null ? ' · no cap' : ` / ${capLabel(selected.stt_limit_seconds)}`}
                  </p>
                  <div className="quota-presets">
                    <button className={`ghost${selected.stt_limit_seconds == null ? ' on' : ''}`} type="button" onClick={() => void saveQuota(null)}>
                      Unlimited
                    </button>
                    {PRESETS.map((n) => (
                      <button
                        key={n}
                        className={`ghost${selected.stt_limit_seconds === n * 60 ? ' on' : ''}`}
                        type="button"
                        onClick={() => void saveQuota(n)}
                      >
                        {n >= 60 ? `${n / 60} hr` : `${n} min`}
                      </button>
                    ))}
                  </div>
                  <form
                    className="quota-custom"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const n = Number(minutes)
                      if (!Number.isFinite(n) || n < 0) return
                      void saveQuota(n)
                    }}
                  >
                    <input
                      className="search"
                      value={minutes}
                      onChange={(e) => setMinutes(e.target.value)}
                      placeholder="Custom minutes"
                      inputMode="decimal"
                    />
                    <button className="ghost" type="submit">
                      Save
                    </button>
                  </form>
                  {quotaMsg && <p className="site-ok">{quotaMsg}</p>}
                </div>
                {(selected.history || []).map((s) => (
                  <p key={s.id} className="sub">
                    {s.mode} · {s.title} · {mins(s.stt_seconds)} · ${s.cost_usd.toFixed(3)}
                  </p>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'sessions' && (
          <>
            <div className="admin-top">
              <div>
                <h1>Sessions</h1>
                <p className="sub">Audio is not stored. This is duration, tokens, and estimated cost only.</p>
              </div>
            </div>
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Mode</th>
                    <th>Title</th>
                    <th>Duration</th>
                    <th>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{s.started_at ? new Date(s.started_at).toLocaleString() : '—'}</td>
                      <td>{s.email}</td>
                      <td>{s.mode}</td>
                      <td>
                        {s.title}
                        {s.discarded ? <span className="muted"> · discarded</span> : null}
                      </td>
                      <td>{mins(s.stt_seconds)}</td>
                      <td>${s.cost_usd.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'feedback' && (
          <>
            <div className="admin-top">
              <div>
                <h1>Feedback</h1>
                <p className="sub">Notes sent from Account.</p>
              </div>
            </div>
            <div className="feed">
              {feedback.map((f) => (
                <article key={f.id}>
                  <small>
                    {f.email || 'unknown'} · {f.created_at ? new Date(f.created_at).toLocaleString() : ''}
                  </small>
                  <p>{f.message}</p>
                </article>
              ))}
              {feedback.length === 0 && <p className="sub">No feedback yet.</p>}
            </div>
          </>
        )}

        {tab === 'settings' && overview && (
          <>
            <div className="admin-top">
              <div>
                <h1>Settings</h1>
                <p className="sub">Paid plans are not enabled. This console is for testers and usage only.</p>
              </div>
            </div>
            <div className="card">
              <div className="toggle">
                <div>
                  <b>Usage limits</b>
                  <p className="sub">Off by default. A per-user monthly transcription cap still applies if you set one.</p>
                </div>
                <span className="tag test">Off</span>
              </div>
              <div className="toggle">
                <div>
                  <b>Global daily budget</b>
                  <p className="sub">Shown for cost tracking only. Not enforced in test mode.</p>
                </div>
                <b>${overview.global_daily_budget_usd}</b>
              </div>
              <div className="toggle" style={{ border: 0 }}>
                <div>
                  <b>Backup</b>
                  <p className="sub">Write a database snapshot to data/backups.</p>
                </div>
                <button className="ghost" type="button" onClick={() => void runBackup()}>
                  Run backup
                </button>
              </div>
              {backupMsg && <p className="site-ok">{backupMsg}</p>}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
