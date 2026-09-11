import { IPHONE_COPY, listenClock, listenStatusDot } from '../iphoneCopy'
import { volumeBarHeights } from '../listenChrome'
import AskBubble from './AskBubble'

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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

export default function ListenRecordBar({
  paused,
  elapsedMs,
  askOpen,
  onPause,
  onResume,
  onStop,
  onAskToggle,
}: {
  paused: boolean
  elapsedMs: number
  askOpen: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onAskToggle: () => void
}) {
  const clock = listenClock(elapsedMs)
  const tone = listenStatusDot({ listening: !paused, paused })
  const bars = volumeBarHeights(null)
  return (
    <div className="iphone-live-bar" role="group" aria-label={paused ? IPHONE_COPY.pausedStatus : IPHONE_COPY.recordingStatus}>
      <span className={`iphone-live-meter ${paused ? 'paused' : 'live'}`}>
        <i className={`iphone-dot ${tone}`} />
        <span className="iphone-vol" aria-hidden="true">
          {bars.map((h, i) => (
            <i key={i} style={{ height: `${Math.round(h * 18)}px` }} />
          ))}
        </span>
        <span className="iphone-clock">{clock}</span>
      </span>
      {paused ? (
        <button type="button" className="iphone-live-ctrl" onClick={onResume} aria-label={IPHONE_COPY.resume}>
          {IPHONE_COPY.resume}
        </button>
      ) : (
        <button type="button" className="iphone-live-ctrl" onClick={onPause} aria-label={IPHONE_COPY.pause}>
          <PauseIcon />
        </button>
      )}
      <button type="button" className="iphone-live-ctrl iphone-live-end" onClick={onStop}>
        <StopIcon />
        {IPHONE_COPY.stop}
      </button>
      <AskBubble expanded={askOpen} onClick={onAskToggle} />
    </div>
  )
}
