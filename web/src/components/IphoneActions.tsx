import { IPHONE_COPY, listenClock, listenShowsRecClock, listenStatusDot, moreMenuEnabled } from '../iphoneCopy'

function MicIcon() {
  return (
    <svg className="iphone-mic" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="5" y="1.4" width="4" height="6.4" rx="2" fill="currentColor" />
      <path d="M3.2 6.6a3.8 3.8 0 0 0 7.6 0M7 10.4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.4" y="2" width="2.4" height="8" rx="0.8" fill="currentColor" />
      <rect x="7.2" y="2" width="2.4" height="8" rx="0.8" fill="currentColor" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.2" fill="currentColor" />
    </svg>
  )
}

function StatusWave({ live }: { live: boolean }) {
  return (
    <span className={`iphone-status-wave${live ? ' live' : ''}`} aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => <i key={i} />)}
    </span>
  )
}

function MoreDots() {
  return (
    <svg className="iphone-more-dots" width="18" height="6" viewBox="0 0 18 6" fill="none" aria-hidden="true">
      <circle cx="3" cy="3" r="2" fill="currentColor" />
      <circle cx="9" cy="3" r="2" fill="currentColor" />
      <circle cx="15" cy="3" r="2" fill="currentColor" />
    </svg>
  )
}

function MoreButton({ className, onClick }: { className: string; onClick: () => void }) {
  return (
    <button type="button" className={className} aria-label={IPHONE_COPY.more} onClick={onClick}>
      <MoreDots />
    </button>
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

function SaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M5 3.4h8.2L14.6 5.8V14.6H5V3.4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.6 3.4v3.6h5.2V3.4M6.6 14.6v-4.2h4.8v4.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4.2 9.2a4.8 4.8 0 1 0 1.3-3.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.4 3.8v3.2h3.2M9 6.4V9.2l2 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NewIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 4v10M4 9h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export default function IphoneActions({
  listening,
  paused,
  muted,
  elapsedMs,
  canSave,
  hasContent,
  onStart,
  onPause,
  onResume,
  onStop,
  onMore,
  moreOpen,
  onCloseMore,
  onExportPdf,
  onSave,
  onHistory,
  onNew,
  variant = 'listen',
}: {
  listening: boolean
  paused: boolean
  muted: boolean
  elapsedMs: number
  canSave: boolean
  hasContent: boolean
  variant?: 'listen' | 'translate' | 'interview'
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onMore: () => void
  moreOpen: boolean
  onCloseMore: () => void
  onExportPdf: () => void
  onSave: () => void
  onHistory: () => void
  onNew: () => void
}) {
  const ready = !listening && !paused
  const menu = moreMenuEnabled({ hasContent, canSave })
  const clock = listenClock(elapsedMs)
  const tone = listenStatusDot({ listening, paused })
  const recClock = listenShowsRecClock(variant)
  return (
    <>
      <div className={`iphone-actions${ready ? ' ready' : ''}${listening ? ' live' : ''}${paused ? ' paused' : ''}${variant === 'translate' ? ' translate' : ''}`}>
        {ready ? (
          <div className="iphone-start-row">
            <MoreButton className="iphone-more-sq" onClick={onMore} />
            <button type="button" className="iphone-btn primary iphone-start" onClick={onStart}>
              <MicIcon />
              {variant === 'translate' ? IPHONE_COPY.start : IPHONE_COPY.startListening}
            </button>
          </div>
        ) : listening ? (
          <div className="iphone-status-row">
            <span className="iphone-status rec" aria-live="polite">
              {IPHONE_COPY.recordingStatus}
              {recClock ? (
                <>
                  <i className={`iphone-dot ${tone}`} />
                  <span className="iphone-clock">{clock}</span>
                </>
              ) : (
                <StatusWave live />
              )}
            </span>
            <button type="button" className="iphone-pill" onClick={onPause}>
              <PauseIcon />
              {IPHONE_COPY.pause}
            </button>
            <button type="button" className="iphone-pill stop" onClick={onStop}>
              <StopIcon />
              {IPHONE_COPY.stop}
            </button>
          </div>
        ) : paused ? (
          <div className="iphone-status-row">
            <span className="iphone-status hold">
              <i className={`iphone-dot ${tone}`} />
              {IPHONE_COPY.pausedStatus}
              {recClock ? <> {clock}</> : null}
            </span>
            <MoreButton className="iphone-more-inline" onClick={onMore} />
            <button type="button" className="iphone-cta" onClick={onResume}>
              <MicIcon />
              {IPHONE_COPY.startListening}
            </button>
            <button type="button" className="iphone-pill stop" onClick={onStop}>
              <StopIcon />
              {IPHONE_COPY.stop}
            </button>
          </div>
        ) : null}
        {muted ? <span className="iphone-muted">{IPHONE_COPY.muted}</span> : null}
      </div>
      {moreOpen && (
        <div className="iphone-more" role="dialog" aria-label={IPHONE_COPY.more}>
          <button type="button" className="iphone-more-backdrop" aria-label={IPHONE_COPY.moreCancel} onClick={onCloseMore} />
          <div className="iphone-more-dock">
            <div className="iphone-more-sheet">
              <button type="button" disabled={!menu.pdf} onClick={() => { onCloseMore(); onExportPdf() }}>
                <PdfIcon />
                {IPHONE_COPY.morePdf}
              </button>
              <button type="button" disabled={!menu.save} onClick={() => { onCloseMore(); onSave() }}>
                <SaveIcon />
                {IPHONE_COPY.moreSave}
              </button>
              <button type="button" disabled={!menu.history} onClick={() => { onCloseMore(); onHistory() }}>
                <HistoryIcon />
                {IPHONE_COPY.moreHistory}
              </button>
              <button type="button" disabled={!menu.newSession} onClick={() => { onCloseMore(); onNew() }}>
                <NewIcon />
                {IPHONE_COPY.moreNew}
              </button>
            </div>
            <button type="button" className="iphone-more-cancel" onClick={onCloseMore}>{IPHONE_COPY.moreCancel}</button>
          </div>
        </div>
      )}
    </>
  )
}
