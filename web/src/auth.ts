const TOKEN_KEY = 'nod_token'
const GUEST_TOKEN_KEY = 'nod_guest_token'

export type Quota = {
  ok: boolean
  reason?: string
  plan?: string
  plan_name?: string
  guest?: boolean
  stt_seconds: number
  stt_limit: number
  llm_tokens: number
  llm_limit: number
  sessions: number
  session_limit: number
  daily_cost_usd: number
  daily_cost_limit: number
  consent?: boolean
}

export type Me = {
  id: string
  email: string
  name: string
  plan: string
  plan_name: string
  subscription_status: string
  consent: boolean
  created_at: string | null
  usage: Quota
  plans: Array<{
    id: string
    name: string
    stt_seconds: number
    llm_tokens: number
    price_cents: number
    interval: string | null
    blurb: string
  }>
  stripe_enabled: boolean
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.removeItem(GUEST_TOKEN_KEY)
    } else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export function getGuestToken(): string {
  try {
    return localStorage.getItem(GUEST_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setGuestToken(token: string): void {
  try {
    if (token) localStorage.setItem(GUEST_TOKEN_KEY, token)
    else localStorage.removeItem(GUEST_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export type GuestSession = {
  token: string
  guest_id: string
  usage: Quota
}

export async function ensureGuestSession(): Promise<GuestSession | null> {
  try {
    const res = await fetch('/api/guest/session', { method: 'POST', credentials: 'include' })
    if (!res.ok) return null
    const data = (await res.json()) as GuestSession & { ok?: boolean }
    if (!data.token) return null
    setGuestToken(data.token)
    return { token: data.token, guest_id: data.guest_id, usage: data.usage }
  } catch {
    return null
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...init, headers, credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as T & { detail?: unknown }
  if (!res.ok) {
    const detail = data?.detail
    const message = typeof detail === 'string' ? detail : res.status === 401 ? 'Please sign in' : `Request failed (${res.status})`
    throw new Error(message)
  }
  return data
}

export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/api/me')
  } catch {
    return null
  }
}

export function logout(): void {
  setToken('')
  setGuestToken('')
  void api('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
}
