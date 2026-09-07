import { IPHONE_COPY, listenClock, listenControlMode, listenShowsRecClock, listenStatusDot, moreMenuEnabled, moreSaveRow } from '../iphoneCopy'
import PhoneSheet from './PhoneSheet'

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

function PdfIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="4" y="2.5" width="10" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.4 7h5.2M6.4 9.6h5.2M6.4 12.2h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M5 3.4h8.2L14.6 5.8V14.6H5V3.4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.6 3.4v3.6h5.2V3.4M6.6 14.6v-4.2h4.8v4.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4.2 9.4l3.2 3.2 6.4-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4.2 9.2a4.8 4.8 0 1 0 1.3-3.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.4 3.8v3.2h3.2M9 6.4V9.2l2 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NewIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
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
  saved = false,
  ended = false,
  onStart,
  onPause,
  onResume,
  onStop,
  onMore: _onMore,
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
  saved?: boolean
  ended?: boolean
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
  const chrome = listenControlMode({ listening, paused, ended, hasContent, variant })
  const menu = moreMenuEnabled({ hasContent, canSave })
  const saveRow = moreSaveRow({ saved, canSave })
  const clock = listenClock(elapsedMs)
  const tone = listenStatusDot({ listening, paused })
  const recClock = listenShowsRecClock(variant)

  return (
    <>
      <div className={`iphone-actions${chrome === 'ready' ? ' ready' : ''}${listening ? ' live' : ''}${paused ? ' paused' : ''}${chrome === 'ended' ? ' ended' : ''}${variant === 'translate' ? ' translate' : ''}`}>
        {chrome === 'ready' ? (
          <div className="iphone-start-row">
            <button type="button" className="iphone-btn primary iphone-start" onClick={onStart}>
              <MicIcon />
              {variant === 'translate' ? IPHONE_COPY.startTranslate : IPHONE_COPY.startListening}
            </button>
          </div>
        ) : variant === 'translate' ? (
          listening ? (
          <div className="iphone-status-row">
            <span className="iphone-status rec" aria-live="polite">
              <i className={`iphone-dot ${tone}`} />
              {IPHONE_COPY.translateStatus}
            </span>
            <button type="button" className="iphone-pill" onClick={onPause}>
              <PauseIcon />
              {IPHONE_COPY.pause}
            </button>
            <button type="button" className="iphone-pill stop" onClick={onStop}>
              <StopIcon />
              {IPHONE_COPY.translateStop}
            </button>
          </div>
          ) : paused ? (
          <div className="iphone-status-row">
            <span className="iphone-status hold">
              <i className={`iphone-dot ${tone}`} />
              {IPHONE_COPY.pausedStatus}
              {recClock ? <> {clock}</> : null}
            </span>
            <button type="button" className="iphone-cta" onClick={onResume}>
              <MicIcon />
              {IPHONE_COPY.resume}
            </button>
            <button type="button" className="iphone-pill stop" onClick={onStop}>
              <StopIcon />
              {IPHONE_COPY.translateStop}
            </button>
          </div>
          ) : null
        ) : listening ? (
          <div className="iphone-status-row" role="group" aria-label={IPHONE_COPY.recordingStatus}>
            <span className="iphone-rec-cell iphone-status rec" aria-live="polite">
              <i className={`iphone-dot ${tone}`} />
              {IPHONE_COPY.recordingStatus}
            </span>
            {recClock ? (
              <>
                <span className="iphone-rec-rule" aria-hidden="true" />
                <span className="iphone-rec-cell iphone-clock">{clock}</span>
              </>
            ) : null}
            <span className="iphone-rec-rule" aria-hidden="true" />
            <button type="button" className="iphone-rec-cell iphone-rec-pause" onClick={onPause} aria-label={IPHONE_COPY.pause}>
              <PauseIcon />
            </button>
            <span className="iphone-rec-rule" aria-hidden="true" />
            <button type="button" className="iphone-rec-cell iphone-rec-end" onClick={onStop}>
              {IPHONE_COPY.stop}
            </button>
          </div>
        ) : paused ? (
          <div className="iphone-status-row" role="group" aria-label={IPHONE_COPY.pausedStatus}>
            <span className="iphone-rec-cell iphone-status hold">
              <i className={`iphone-dot ${tone}`} />
              {IPHONE_COPY.pausedStatus}
            </span>
            {recClock ? (
              <>
                <span className="iphone-rec-rule" aria-hidden="true" />
                <span className="iphone-rec-cell iphone-clock">{clock}</span>
              </>
            ) : null}
            <span className="iphone-rec-rule" aria-hidden="true" />
            <button type="button" className="iphone-rec-cell iphone-rec-resume" onClick={onResume}>
              {IPHONE_COPY.resume}
            </button>
            <span className="iphone-rec-rule" aria-hidden="true" />
            <button type="button" className="iphone-rec-cell iphone-rec-end" onClick={onStop}>
              {IPHONE_COPY.stop}
            </button>
          </div>
        ) : chrome === 'ended' ? (
          <div className="iphone-status-row" role="group" aria-label={`${IPHONE_COPY.endedStatus} · ${clock}`}>
            <span className="iphone-ended-clock">{IPHONE_COPY.endedStatus} · {clock}</span>
            <button type="button" className="iphone-btn primary iphone-start" onClick={onStart}>
              <MicIcon />
              {IPHONE_COPY.startListening}
            </button>
          </div>
        ) : null}
        {muted ? <span className="iphone-muted">{IPHONE_COPY.muted}</span> : null}
      </div>
      <PhoneSheet
        open={moreOpen}
        title={IPHONE_COPY.more}
        subtitle={IPHONE_COPY.moreSession}
        onClose={onCloseMore}
        footer={
          <button type="button" className="iphone-more-cancel" onClick={onCloseMore}>{IPHONE_COPY.moreCancel}</button>
        }
      >
        <div className="iphone-more-rows">
          <button type="button" disabled={!menu.pdf} onClick={() => { onCloseMore(); onExportPdf() }}>
            <PdfIcon />
            {IPHONE_COPY.morePdf}
          </button>
          <button type="button" disabled={saveRow.disabled} onClick={() => { onCloseMore(); onSave() }}>
            {saved ? <CheckIcon /> : <SaveIcon />}
            <span className="iphone-more-copy">
              <span>{saveRow.label}</span>
              {saveRow.hint ? <span className="iphone-more-hint">{saveRow.hint}</span> : null}
            </span>
            {saveRow.trailing ? <span className="iphone-more-trail">{saveRow.trailing}</span> : null}
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
      </PhoneSheet>
    </>
  )
}
