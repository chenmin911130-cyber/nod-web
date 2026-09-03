import { getToken } from './auth'
import type { HistoryFile, HistorySession } from './components/HistoryPane'
import { renderHistoryPdf } from './historyPdf'
import { apiUrl, isNativeApp } from './native'
import { pdfDownloadName } from './pdfBrand'
import { saveNativeFiles } from './watch'

export function isRiffWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const tag = (start: number, n: number) => String.fromCharCode(...bytes.subarray(start, start + n))
  return tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE'
}

export function nativeAudioHref(href: string): string {
  if (!href || /[?&]proxy=/.test(href)) return href
  return `${href}${href.includes('?') ? '&' : '?'}proxy=1`
}

export async function fetchExportBytes(href: string): Promise<Uint8Array> {
  const headers = new Headers()
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(apiUrl(href), { headers, credentials: 'include' })
  if (!res.ok) throw new Error(res.status === 401 ? 'Please sign in' : `Could not download file (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function saveSessionToFiles(session: HistorySession, kinds: { pdf?: boolean; audio?: boolean } = { pdf: true, audio: true }): Promise<string> {
  const files: Array<{ bytes: Uint8Array; name: string }> = []
  if (kinds.pdf !== false) {
    files.push(await renderHistoryPdf(session))
  }
  const remotes: Array<{ url: string; name: string; token?: string }> = []
  if (kinds.audio !== false) {
    const audio = (session.files || []).filter((file: HistoryFile) => file.kind === 'audio' && file.href)
    for (const file of audio) {
      const name = pdfDownloadName(file.name || 'recording', 'wav')
      if (isNativeApp()) {
        remotes.push({
          url: apiUrl(file.href),
          name,
          token: getToken() || undefined,
        })
        continue
      }
      const bytes = await fetchExportBytes(nativeAudioHref(file.href))
      if (!isRiffWav(bytes)) {
        throw new Error('Recording is not ready yet. Stop and save again in a moment.')
      }
      files.push({ bytes, name })
    }
  }
  if (!files.length && !remotes.length) throw new Error(isNativeApp() ? 'Nothing to save to Files' : 'Nothing to download')
  await saveNativeFiles(files, remotes)
  return [...files.map((file) => file.name), ...remotes.map((file) => file.name)].join(', ')
}
