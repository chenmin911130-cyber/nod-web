import { IPHONE_COPY, listenClock, listenStatusDot } from '../iphoneCopy'
import { METER_BAR_PX, volumeBarHeights, type BottomBarMode } from '../listenChrome'

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="7" y="1.6" width="4" height="8.4" rx="2" fill="currentColor" />
      <path d="M4.6 8.4a4.4 4.4 0 0 0 8.8 0M9 12.8v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.4" y="2" width="2.4" height="8" rx="0.8" fill="currentColor" />
      <rect x="7.2" y="2" width="2.4" height="8" rx="0.8" fill="currentColor" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.2" fill="currentColor" />
    </svg>
  )
}

/**
 * #193 items 4/5: the one bottom bar for the phone Listen and Translate
 * workspaces. `ready` and `ended` are single full-width primary pills; capture
 * draws indicator + honest static meter + clock on the left and the round
 * pause/resume plus a separated End on the right. Ask is NOT here any more —
 * it is the single draggable bubble above this bar.
 */
export default function ListenRecordBar({
  mode,
  elapsedMs,
  startLabel,
  stopLabel,
  continueLabel,
  statusLabel,
  onStart,
  onPause,
  onResume,
  onStop,
  onContinue,
  meterLevel = null,
}: {
  mode: BottomBarMode
  elapsedMs: number
  startLabel: string
  stopLabel: string
  continueLabel?: string
  statusLabel?: string
  onStart?: () => void
  onPause?: () => void
  onResume?: () => void
  onStop?: () => void
  onContinue?: () => void
  meterLevel?: number | null
}) {
  const paused = mode === 'paused'
  const clock = listenClock(elapsedMs)
  const tone = listenStatusDot({ listening: !paused, paused })
  const bars = volumeBarHeights(meterLevel)

  if (mode === 'ready' || mode === 'ended') {
    return (
      <div className={`iphone-live-bar iphone-bar-${mode}`}>
        <button
          type="button"
          className="iphone-bar-primary"
          onClick={mode === 'ended' ? onContinue : onStart}
        >
          {mode === 'ended' ? null : <MicIcon />}
          {mode === 'ended' ? continueLabel || IPHONE_COPY.continueRecording : startLabel}
        </button>
      </div>
    )
  }

  return (
    <div
      className={`iphone-live-bar iphone-bar-${mode}`}
      role="group"
      aria-label={statusLabel || (paused ? IPHONE_COPY.pausedStatus : IPHONE_COPY.recordingStatus)}
    >
      <span className={`iphone-live-meter ${paused ? 'paused' : 'live'}`}>
        <i className={`iphone-dot ${tone}`} />
        <span className="iphone-vol" aria-hidden="true">
          {bars.map((h, i) => (
            <i key={i} style={{ height: `${Math.round(h * METER_BAR_PX)}px` }} />
          ))}
        </span>
        <span className="iphone-clock">{clock}</span>
      </span>
      {paused ? (
        <button type="button" className="iphone-live-ctrl iphone-live-resume" onClick={onResume} aria-label={IPHONE_COPY.resume}>
          {IPHONE_COPY.resume}
        </button>
      ) : (
        <button type="button" className="iphone-live-ctrl" onClick={onPause} aria-label={IPHONE_COPY.pause}>
          <PauseIcon />
        </button>
      )}
      <span className="iphone-live-sep" aria-hidden="true" />
      <button type="button" className="iphone-live-ctrl iphone-live-end" onClick={onStop}>
        <StopIcon />
        {stopLabel}
      </button>
    </div>
  )
}
