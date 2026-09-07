const TOKEN_KEY = 'nod_token'

export type Quota = {
  ok: boolean
  reason?: string
  plan?: string
  plan_name?: string
  stt_seconds: number
  stt_limit: number
  llm_tokens: number
  llm_limit: number
  sessions: number
  session_limit: number
  daily_cost_usd: number
  daily_cost_limit: number
  daily_stt_seconds?: number
  daily_stt_limit?: number
  consent?: boolean
  quota_disabled?: boolean
  stt_limit_seconds?: number | null
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
  quota_disabled?: boolean
  sign_in?: 'google' | 'email'
}

import { apiUrl, isNativeApp } from './native'

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(apiUrl(path), { ...init, headers, credentials: 'include' })
  const data = (await res.json().catch(() => ({}))) as T & { detail?: unknown }
  if (!res.ok) {
    const detail = data?.detail
    const message = typeof detail === 'string' ? detail : res.status === 401 ? 'Please sign in' : `Request failed (${res.status})`
    throw new Error(message)
  }
  return data
}

export function isLocalHost(): boolean {
  if (isNativeApp()) return false
  return location.hostname === '127.0.0.1' || location.hostname === 'localhost'
}

export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/api/me')
  } catch {
    return null
  }
}

export async function ensureLocalGuest(): Promise<Me | null> {
  if (!isLocalHost()) return null
  try {
    const out = await api<{ token?: string; user?: Me }>('/api/auth/local-guest', { method: 'POST' })
    if (out.token) setToken(out.token)
    return out.user || (await fetchMe())
  } catch {
    return {
      id: 'local-guest',
      email: 'local@nod.test',
      name: 'Local test',
      plan: 'free',
      plan_name: 'Free',
      subscription_status: 'none',
      consent: true,
      created_at: null,
      usage: {
        ok: true,
        stt_seconds: 0,
        stt_limit: 0,
        llm_tokens: 0,
        llm_limit: 0,
        sessions: 0,
        session_limit: 0,
        daily_cost_usd: 0,
        daily_cost_limit: 0,
        quota_disabled: true,
      },
      plans: [],
      stripe_enabled: false,
      quota_disabled: true,
    }
  }
}

export async function logout(): Promise<void> {
  setToken('')
  // keepalive lets the request finish even if the page navigates right after.
  await api('/api/auth/logout', { method: 'POST', keepalive: true }).catch(() => undefined)
}

export async function deleteAccount(): Promise<void> {
  const out = await api<{ ok?: boolean }>('/api/account', { method: 'DELETE' })
  if (!out || out.ok === false) {
    throw new Error("Couldn't delete your account. Try again.")
  }
}
