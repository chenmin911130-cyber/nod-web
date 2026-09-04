import type { CaptureState, EngineState, WorkspaceMode } from '../types'

interface Props {
  mode: WorkspaceMode
  capture: CaptureState
  engine: EngineState
  autoOn: boolean
  onPrimary: () => void
  onRecord: () => void
  onPause: () => void
  onMark: () => void
  onExport: () => void
  meetingPaused?: boolean
  onClose?: () => void
  onOpenHistory?: () => void
  onNewSession?: () => void
  onSaveSession?: () => void
  canSaveSession?: boolean
  sessionSaved?: boolean
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <line x1="12" y1="17" x2="12" y2="20" />
      <line x1="8" y1="20" x2="16" y2="20" />
    </svg>
  )
}

function WaveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <line x1="5" y1="10" x2="5" y2="14" />
      <line x1="9" y1="6" x2="9" y2="18" />
      <line x1="13" y1="4" x2="13" y2="20" />
      <line x1="17" y1="7" x2="17" y2="17" />
      <line x1="21" y1="10" x2="21" y2="14" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 6.8v10.4L18 12z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M8 7v6M12 7v6" />
    </svg>
  )
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3.5v13" />
      <path d="M5 4.2h9l-2 3.2 2 3.2H5" />
    </svg>
  )
}

function PdfIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5h6l3 3V16.5H6z" />
      <path d="M12 3.5V7h3" />
      <path d="M8 12h4M8 14.5h2.5" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3.5h8.2L15.5 6v10.5H5z" />
      <path d="M7 3.5V7h6V3.5" />
      <path d="M7 16.5v-4.2h6v4.2" />
    </svg>
  )
}

function RecIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="3.4" fill="currentColor" />
    </svg>
  )
}

function MiniWave() {
  return (
    <span className="rail-wave-mini" aria-hidden="true">
      <span /><span /><span /><span /><span />
    </span>
  )
}

function NewSessionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.2" y="3.6" width="11.6" height="12.8" rx="1.6" />
      <path d="M10 7.4v5.2M7.4 10h5.2" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.2" y="3.5" width="11.6" height="13" rx="1.6" />
      <path d="M7 7.2h6M7 10h6M7 12.8h4" />
    </svg>
  )
}

function primaryLabel(listening: boolean): string {
  return listening ? 'Stop' : 'Start'
}

export default function SideRail(props: Props) {
  const { mode, capture, engine, autoOn, meetingPaused } = props
  const recording = capture === 'recording'
  const listening = capture === 'listening' || recording
  const primaryOn = mode === 'interview' ? autoOn || capture === 'listening' : listening
  const primaryDisabled = mode === 'interview' || mode === 'translate' ? recording : false
  const live = primaryOn || recording

  const statusLabel = recording
    ? 'Recording'
    : listening
      ? (mode === 'meeting' ? 'In meeting' : 'Listening')
      : meetingPaused
        ? 'Paused'
        : engine !== 'idle'
          ? 'Thinking'
          : 'Ready'

  return (
    <div className={`side-rail${mode === 'translate' ? ' translate-rail' : ''}`}>
      {props.onClose && (
        <button className="rail-close" type="button" onClick={props.onClose} title="Hide sidebar">
          <span aria-hidden="true">×</span>
        </button>
      )}
      <button
        className={`rail-primary${primaryOn ? ' active' : ''}${meetingPaused && !listening ? ' paused' : ''}`}
        onClick={props.onPrimary}
        disabled={primaryDisabled}
        aria-label={primaryLabel(primaryOn)}
        title={
          mode === 'interview'
            ? (primaryOn ? 'Stop Auto Listen (F3)' : 'Start Auto Listen (F3)')
            : mode === 'translate'
              ? (listening ? 'Stop listening to system audio (F3)' : 'Listen to system audio (F3)')
              : meetingPaused && !listening
                ? 'Start'
                : primaryLabel(listening)
        }
      >
        <span className="rail-primary-ring">
          {meetingPaused && !listening ? <PlayIcon /> : mode === 'meeting' ? <WaveIcon /> : <MicIcon />}
          {live && <MiniWave />}
        </span>
        <span className="rail-primary-label">{primaryLabel(primaryOn)}</span>
      </button>

      {mode === 'interview' && (
        <button className="rail-icon-btn" onClick={props.onExport} title="Export answers as PDF">
          <PdfIcon />
          <span className="rail-lbl-full">Export PDF</span>
          <span className="rail-lbl-short">PDF</span>
        </button>
      )}

      {mode === 'meeting' && (
        <>
          {listening && (
            <button
              className="rail-icon-btn"
              onClick={props.onPause}
              title="Pause and keep this session"
            >
              <PauseIcon />
              <span>Pause</span>
            </button>
          )}
          <button
            className={`rail-icon-btn${recording ? ' live' : ''}`}
            onClick={props.onRecord}
            disabled={autoOn}
            title={
              listening || meetingPaused
                ? 'Finish and write report'
                : 'Record, then auto-write a report'
            }
          >
            <RecIcon />
            <span className="rail-lbl-full">{listening || meetingPaused ? 'Stop + Report' : 'Record'}</span>
            <span className="rail-lbl-short">Rec</span>
          </button>
          <button className="rail-icon-btn" onClick={props.onExport} title="Summarize all sections and export PDF">
            <PdfIcon />
            <span className="rail-lbl-full">Export PDF</span>
            <span className="rail-lbl-short">PDF</span>
          </button>
        </>
      )}

      {mode === 'translate' && (
        <>
          <button
            className={`rail-icon-btn${recording ? ' live' : ''}`}
            onClick={props.onRecord}
            disabled={autoOn || capture === 'listening'}
            title={recording ? 'Stop recording (F2)' : 'Record your microphone (F2)'}
          >
            <RecIcon />
            <span className="rail-lbl-full">{recording ? 'Recording' : 'Record'}</span>
            <span className="rail-lbl-short">Rec</span>
          </button>
        </>
      )}

      {mode === 'meeting' && props.onSaveSession ? (
        <button
          type="button"
          className={`rail-icon-btn${props.sessionSaved ? ' saved' : ''}`}
          onClick={props.onSaveSession}
          title={props.sessionSaved ? 'Open this session in History' : 'Save this session to History'}
        >
          <SaveIcon />
          <span>Save</span>
        </button>
      ) : null}
      <button
        type="button"
        className="rail-icon-btn"
        onClick={props.onOpenHistory}
        title="Open session history"
      >
        <HistoryIcon />
        <span>History</span>
      </button>
      <button
        type="button"
        className="rail-icon-btn"
        onClick={props.onNewSession}
        title="Start a new session"
      >
        <NewSessionIcon />
        <span className="rail-lbl-full">New session</span>
        <span className="rail-lbl-short">New</span>
      </button>
      {mode === 'translate' && (
        <button className="rail-icon-btn" onClick={props.onExport} title="Export translation as PDF">
          <PdfIcon />
          <span className="rail-lbl-full">Export PDF</span>
          <span className="rail-lbl-short">PDF</span>
        </button>
      )}

      <div className="rail-status">
        <span className={`rail-dot-live${listening ? ' on' : ''}`} />
        <span>{statusLabel}</span>
      </div>
    </div>
  )
}
