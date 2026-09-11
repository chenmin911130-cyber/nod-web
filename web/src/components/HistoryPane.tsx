import { useEffect, useState } from 'react'
import { api } from '../auth'
import { saveSessionToFiles } from '../sessionExport'
import {
  historyRowWhen,
  historySessionMatches,
  mergePendingHistory,
  mergeLocalCaptures,
  modeIsSaveEligible,
  overlayNativeSaveJobs,
  sceneOf,
  sessionHasAudio,
  sessionShowsUnsaved,
} from '../historyRestore'
import { copyFlashText, useCopyFlash } from '../copyFeedback'
import { IPHONE_COPY } from '../iphoneCopy'
import { isNativeApp } from '../native'
import { listWatchSaves, retryWatchSave } from '../watch'

export type HistoryItem = { kind: string; text: string; at?: string | null; qid?: string; speaker?: string }
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
  kept?: boolean
  nativeSave?: string
  captureId?: string
  nativeError?: string
}

function DocIcon() {
  return (
    <svg className="hist-doc" width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="4.2" y="3.2" width="13.6" height="15.6" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.2 8.2h7.6M7.2 11.2h7.6M7.2 14.2h4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg className="hist-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.4 10.4 13.2 13.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg className="hist-search-mic" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="2.2" width="4" height="7.2" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.2 8.2a3.8 3.8 0 0 0 7.6 0M8 12v1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function MoreDots() {
  return (
    <svg width="16" height="4" viewBox="0 0 16 4" fill="none" aria-hidden="true">
      <circle cx="2" cy="2" r="1.6" fill="currentColor" />
      <circle cx="8" cy="2" r="1.6" fill="currentColor" />
      <circle cx="14" cy="2" r="1.6" fill="currentColor" />
    </svg>
  )
}

function OpenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="4" y="3" width="10" height="12" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.4 7h5.2M6.4 9.6h5.2M6.4 12.2h3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 10.4V3.4M9 3.4 6.4 6M9 3.4 11.6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.4 8.2v6.2h9.2V8.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PdfIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="4" y="2.5" width="10" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.4 7h5.2M6.4 9.6h5.2M6.4 12.2h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3.4 14.4V5.4h4.2l1.4 1.6h5.6v7.4H3.4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4.2 5.4h9.6M7 5.4V3.8h4v1.6M5.6 5.4 6.2 14.2h5.6l.6-8.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function HistoryPane({
  open,
  refreshAt = 0,
  onClose,
  onRestore,
}: {
  open: boolean
  refreshAt?: number
  onClose: () => void
  onRestore?: (session: HistorySession) => void
}) {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [pdfId, setPdfId] = useState('')
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState('')
  const native = isNativeApp()
  const copyFlash = useCopyFlash()

  useEffect(() => {
    if (!open) {
      setQuery('')
      setMenuId('')
      copyFlash.reset()
      return
    }
    setLoading(true)
    setErr('')
    void Promise.all([
      api<{ sessions: HistorySession[] }>('/api/account/history').catch(() => ({ sessions: [] as HistorySession[] })),
      api<{ sessions: HistorySession[] }>('/api/account/history?pending=1').catch(() => ({ sessions: [] as HistorySession[] })),
      native
        ? import('nod-mic').then(({ NodMic }) => NodMic.listPendingCaptures()).catch(() => ({ captures: [] }))
        : Promise.resolve({ captures: [] as Array<{ captureId: string; sessionId: string; bytes: number; sealed: boolean; intent: string; modifiedAt: string; mode?: string }> }),
      native ? listWatchSaves() : Promise.resolve({ saves: [] }),
    ])
      .then(([saved, pending, local, jobs]) => {
        const cloud = mergePendingHistory(saved.sessions || [], pending.sessions || [])
        // #196: a phone-held capture reports the mode it was recorded in. Captures
        // written before that field existed fall back to the mode of the cloud row
        // they belong to; a capture that resolves to NEITHER is left without a mode —
        // unknown is NOT the same as meeting, but it stays recoverable so a real
        // meeting capture never loses its entry.
        const cloudModeOf = (sid: string) =>
          [...(saved.sessions || []), ...(pending.sessions || [])].find((s) => s.id === sid)?.mode || ''
        const withLocal = mergeLocalCaptures(cloud, local.captures || [], (row) => {
          const mode = row.mode || cloudModeOf(row.sessionId)
          return {
            id: row.sessionId || `local:${row.captureId}`,
            mode,
            // "Unsaved" is a Save-side word: a capture in a mode with no Save concept
            // keeps the neutral "Session" title instead (the row stays deletable).
            title: modeIsSaveEligible(mode) ? IPHONE_COPY.saveRestoreTitle : '',
            started_at: row.modifiedAt || null,
            stt_seconds: Math.max(0, Math.round(row.bytes / 32000)),
            items: [],
            kept: false,
          }
        })
        setSessions(overlayNativeSaveJobs(withLocal, jobs.saves || []))
      })
      .catch((ex: Error) => setErr(ex.message))
      .finally(() => setLoading(false))
  }, [open, refreshAt, native])

  if (!open) return null

  const visible = sessions.filter((s) => historySessionMatches(s, query))
  const menuSession = sessions.find((s) => s.id === menuId) || null

  const copySession = (session: HistorySession) => {
    copyFlash.runCopy(session.id, session.copy_text || session.items.map((i) => i.text).join('\n'))
  }

  const exportFiles = async (session: HistorySession, kinds: { pdf?: boolean; audio?: boolean } = { pdf: true, audio: true }) => {
    setPdfId(session.id)
    setErr('')
    try {
      await saveSessionToFiles(session, kinds)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : native ? 'Could not save to Files' : 'Could not download')
    } finally {
      setPdfId('')
    }
  }

  const deleteSession = async (session: HistorySession) => {
    if (!window.confirm(`Delete this ${sceneOf(session)} session? This cannot be undone.`)) return
    setBusyId(session.id)
    setErr('')
    try {
      if (session.id.startsWith('local:')) {
        const { NodMic } = await import('nod-mic')
        await NodMic.deletePendingCapture({ captureId: session.id.slice('local:'.length) })
      } else {
        await api(`/api/account/history/${session.id}`, { method: 'DELETE' })
      }
      setSessions((rows) => rows.filter((row) => row.id !== session.id))
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not delete session')
    } finally {
      setBusyId('')
    }
  }

  return (
      <div className="hist-root hist-page" role="dialog" aria-label={IPHONE_COPY.histTitle}>
        <aside className="hist-panel">
          <header className="hist-head">
            <h2>{IPHONE_COPY.histTitle}</h2>
            <button type="button" className="hist-close" onClick={onClose}>
              {IPHONE_COPY.histDone}
            </button>
          </header>
          <label className="hist-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={IPHONE_COPY.histSearch}
              aria-label={IPHONE_COPY.histSearch}
            />
            <MicIcon />
          </label>
          {loading && <p className="hist-empty">Loading sessions…</p>}
          {err && <p className="hist-err">{err}</p>}
          {!loading && !err && sessions.length === 0 && (
            <p className="hist-empty">No sessions yet. Save a meeting to see it here.</p>
          )}
          {!loading && !err && sessions.length > 0 && visible.length === 0 && (
            <p className="hist-empty">No sessions match that search.</p>
          )}
          <div className="hist-body hist-body-pick">
            <ul className="hist-list">
              {visible.map((s) => (
                <li key={s.id} className={`hist-row${menuId === s.id ? ' on' : ''}`}>
                  <button
                    type="button"
                    className="hist-pick"
                    disabled={busyId === s.id}
                    onClick={() => onRestore?.(s)}
                  >
                    <DocIcon />
                    <span className="hist-pick-copy">
                      <b>{s.title || 'Session'}</b>
                      <small>
                        {sessionShowsUnsaved(s) ? `${IPHONE_COPY.saveRestoreTitle} · ` : ''}
                        {s.nativeSave === 'failed' ? `${IPHONE_COPY.saveFailed} · ` : ''}
                        {s.nativeSave === 'local' ? `${IPHONE_COPY.saveWaitingSync} · ` : ''}
                        {historyRowWhen(s.started_at, s.stt_seconds)}
                      </small>
                    </span>
                  </button>
                  <span className="hist-row-side">
                  {copyFlash.flash?.key === s.id ? (
                    <span className="hist-copy-flash" role="status" aria-live="polite">
                      {copyFlashText(copyFlash.flash.result)}
                    </span>
                  ) : null}
                  {(s.nativeSave === 'failed' || s.nativeSave === 'local') && (
                    <button
                      type="button"
                      className="hist-row-retry"
                      disabled={busyId === s.id}
                      onClick={() => {
                        setBusyId(s.id)
                        retryWatchSave(s.id)
                        window.setTimeout(() => setBusyId(''), 800)
                      }}
                    >
                      {IPHONE_COPY.saveRetry}
                    </button>
                  )}
                  <button
                    type="button"
                    className="hist-row-more"
                    aria-label={IPHONE_COPY.more}
                    onClick={() => setMenuId(s.id)}
                  >
                    <MoreDots />
                  </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
        {menuSession && (
          <div className="hist-more" role="dialog" aria-label={menuSession.title || IPHONE_COPY.more}>
            <button type="button" className="hist-more-backdrop" aria-label={IPHONE_COPY.moreCancel} onClick={() => setMenuId('')} />
            <div className="hist-more-dock">
              <div className="hist-more-sheet">
                <button type="button" onClick={() => { setMenuId(''); onRestore?.(menuSession) }}>
                  <OpenIcon />
                  {IPHONE_COPY.histOpen}
                </button>
                {(menuSession.nativeSave === 'failed' || menuSession.nativeSave === 'local') && (
                  <button type="button" onClick={() => { setMenuId(''); retryWatchSave(menuSession.id) }}>
                    {IPHONE_COPY.saveRetry}
                  </button>
                )}
                <button type="button" onClick={() => { setMenuId(''); copySession(menuSession) }}>
                  <ShareIcon />
                  {IPHONE_COPY.histShare}
                </button>
                <button
                  type="button"
                  disabled={pdfId === menuSession.id}
                  onClick={() => { setMenuId(''); void exportFiles(menuSession, { pdf: true, audio: false }) }}
                >
                  <PdfIcon />
                  {IPHONE_COPY.histPdf}
                </button>
                <button
                  type="button"
                  disabled={pdfId === menuSession.id || !sessionHasAudio(menuSession)}
                  onClick={() => { setMenuId(''); void exportFiles(menuSession, { pdf: false, audio: true }) }}
                >
                  <FolderIcon />
                  {native ? IPHONE_COPY.histAudio : 'Download recording'}
                </button>
                <button
                  type="button"
                  className="hist-del"
                  disabled={busyId === menuSession.id}
                  onClick={() => { setMenuId(''); void deleteSession(menuSession) }}
                >
                  <TrashIcon />
                  {IPHONE_COPY.histDelete}
                </button>
              </div>
              <button type="button" className="hist-more-cancel" onClick={() => setMenuId('')}>
                {IPHONE_COPY.moreCancel}
              </button>
            </div>
          </div>
        )}
      </div>
  )
}
