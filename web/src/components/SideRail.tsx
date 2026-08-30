import { useEffect, useRef, useState } from 'react'
import type { RunState, WorkspaceMode } from '../types'

interface Props {
  mode: WorkspaceMode
  run: RunState
  autoOn: boolean
  onPrimary: () => void
  onRecord: () => void
  onClear: () => void
  onPause: () => void
  onMark: () => void
  onExport: () => void
  meetingPaused?: boolean
  onClose?: () => void
  onOpenHistory?: () => void
  onNewSession?: () => void
}

export function CaptionMode({
  bilingual,
  onChange,
}: {
  bilingual: boolean
  onChange: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className={`listen-scene caption-mode${open ? ' open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className="listen-scene-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Caption mode"
        title={bilingual ? 'Show original and translation together' : 'Show the transcript only'}
        onClick={() => setOpen((v) => !v)}
      >
        {bilingual ? 'Bilingual' : 'Original'}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.2 3.4 5 6.4 7.8 3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="listen-scene-menu caption-mode-menu" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={!bilingual}
            className={bilingual ? '' : 'on'}
            onClick={() => {
              onChange(false)
              setOpen(false)
            }}
          >
            Original
          </button>
          <button
            type="button"
            role="option"
            aria-selected={bilingual}
            className={bilingual ? 'on' : ''}
            onClick={() => {
              onChange(true)
              setOpen(false)
            }}
          >
            Bilingual
          </button>
        </div>
      )}
    </div>
  )
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

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h12" />
      <path d="M8 6V4.6A1.1 1.1 0 0 1 9.1 3.5h1.8A1.1 1.1 0 0 1 12 4.6V6" />
      <rect x="6" y="6" width="8" height="10" rx="1.4" />
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

function MoreIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="4.5" cy="10" r="1.55" />
      <circle cx="10" cy="10" r="1.55" />
      <circle cx="15.5" cy="10" r="1.55" />
    </svg>
  )
}

function primaryLabel(mode: WorkspaceMode, listening: boolean, paused = false): string {
  if (mode === 'meeting') {
    if (listening) return 'Stop Listening'
    if (paused) return 'Resume Listening'
    return 'Start Listening'
  }
  if (mode === 'translate') return listening ? 'Stop Listen' : 'Start Listen'
  return listening ? 'Stop Listening' : 'Start Listening'
}

export default function SideRail(props: Props) {
  const { mode, run, autoOn, meetingPaused } = props
  const recording = run === 'record'
  const listening = run === 'listen' || recording
  const primaryOn = mode === 'interview' ? autoOn || run === 'listen' : listening
  const primaryDisabled = mode === 'interview' || mode === 'translate' ? recording : false
  const live = primaryOn || recording
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMoreOpen(false)
  }, [mode])

  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [moreOpen])

  const statusLabel = recording
    ? 'Recording'
    : listening
      ? (mode === 'meeting' ? 'In meeting' : 'Listening')
      : run === 'think'
        ? 'Thinking'
        : 'Ready'

  return (
    <div className="side-rail">
      {props.onClose && (
        <button className="rail-close" type="button" onClick={props.onClose} title="Hide sidebar">
          <span aria-hidden="true">×</span>
        </button>
      )}
      <button
        className={`rail-primary${primaryOn ? ' active' : ''}`}
        onClick={props.onPrimary}
        disabled={primaryDisabled}
        title={
          mode === 'interview'
            ? (primaryOn ? 'Stop Auto Listen (F3)' : 'Start Auto Listen (F3)')
            : mode === 'translate'
              ? (listening ? 'Stop listening to system audio (F3)' : 'Listen to system audio (F3)')
              : primaryLabel(mode, listening, meetingPaused)
        }
      >
        <span className="rail-primary-ring">
          {mode === 'meeting' ? <WaveIcon /> : <MicIcon />}
          {live && <MiniWave />}
        </span>
        <span className="rail-primary-label">{primaryLabel(mode, primaryOn, meetingPaused)}</span>
      </button>

      {mode === 'interview' && (
        <>
          <button className="rail-icon-btn" onClick={props.onClear} title="Clear history (F4)">
            <TrashIcon />
            <span>Clear</span>
          </button>
          <button className="rail-icon-btn" onClick={props.onExport} title="Export answers as PDF">
            <PdfIcon />
            <span>Export PDF</span>
          </button>
        </>
      )}

      {mode === 'meeting' && (
        <button className="rail-icon-btn" onClick={props.onExport} title="Summarize all sections and export PDF">
          <PdfIcon />
          <span>Export PDF</span>
        </button>
      )}

      {mode === 'translate' && (
        <button
          className={`rail-icon-btn${recording ? ' live' : ''}`}
          onClick={props.onRecord}
          disabled={autoOn || run === 'listen'}
          title={recording ? 'Stop recording (F2)' : 'Record, then transcribe accurately (F2)'}
        >
          <RecIcon />
          <span>{recording ? 'Recording' : 'Record'}</span>
        </button>
      )}

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
        <span>New session</span>
      </button>

      <div className="rail-status">
        <span className={`rail-dot-live${listening ? ' on' : ''}`} />
        <span>{statusLabel}</span>
        {mode === 'translate' && (
          <div className="rail-more-wrap" ref={moreRef}>
            <button
              className={`rail-more-btn${moreOpen ? ' on' : ''}`}
              onClick={() => setMoreOpen((v) => !v)}
              title="Clear and export"
            >
              <MoreIcon />
            </button>
            {moreOpen && (
              <div className="rail-menu">
                <button
                  onClick={() => {
                    props.onClear()
                    setMoreOpen(false)
                  }}
                >
                  Clear (F4)
                </button>
                <button
                  onClick={() => {
                    props.onExport()
                    setMoreOpen(false)
                  }}
                >
                  Export PDF
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
