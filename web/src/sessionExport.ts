import { getToken } from './auth'
import type { HistoryFile, HistorySession } from './components/HistoryPane'
import { renderHistoryPdf } from './historyPdf'
import { apiUrl } from './native'
import { pdfDownloadName } from './pdfBrand'
import { saveNativeFiles } from './watch'

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
  if (kinds.audio !== false) {
    const audio = (session.files || []).filter((file: HistoryFile) => file.kind === 'audio' && file.href)
    for (const file of audio) {
      files.push({
        bytes: await fetchExportBytes(file.href),
        name: pdfDownloadName(file.name || 'recording', 'wav'),
      })
    }
  }
  if (!files.length) throw new Error('Nothing to save to Files')
  await saveNativeFiles(files)
  return files.map((file) => file.name).join(', ')
}
