import { useEffect, useRef, useState } from 'react'
import type { PairLang, RunState, WorkspaceMode } from '../types'

function langTag(code: PairLang): string {
  return code === 'zh' ? 'CH' : 'EN'
}

interface Props {
  mode: WorkspaceMode
  run: RunState
  autoOn: boolean
  bilingual: boolean
  translateFrom: PairLang
  translateTo: PairLang
  onPrimary: () => void
  onRecord: () => void
  onCopy: () => void
  onClear: () => void
  onPause: () => void
  onMark: () => void
  onExport: () => void
  onFlipLang: () => void
  onBilingual: () => void
  meetingPaused?: boolean
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

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="7" width="9" height="10" rx="1.6" />
      <path d="M5 13V5.5A1.5 1.5 0 0 1 6.5 4H13" />
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

function SwapIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h10" />
      <path d="M11 4l3 3-3 3" />
      <path d="M16 13H6" />
      <path d="M9 10l-3 3 3 3" />
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
    if (listening) return 'Stop Meeting'
    if (paused) return 'Resume Meeting'
    return 'Start Meeting'
  }
  if (mode === 'translate') return listening ? 'Stop Listen' : 'Start Listen'
  return listening ? 'Stop Listening' : 'Start Listening'
}

export default function SideRail(props: Props) {
  const { mode, run, autoOn, bilingual, translateFrom, translateTo, meetingPaused } = props
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
      <button
        className={`rail-primary${primaryOn ? ' active' : ''}`}
        onClick={props.onPrimary}
        disabled={primaryDisabled}
        title={
          mode === 'interview'
            ? (primaryOn ? 'Stop Auto Listen (F3)' : 'Start Auto Listen (F3)')
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
          <button
            className={`rail-icon-btn${recording ? ' live' : ''}`}
            onClick={props.onRecord}
            disabled={autoOn || run === 'listen'}
            title={recording ? 'Stop recording (F2)' : 'Record this question (F2)'}
          >
            <RecIcon />
            <span>{recording ? 'Recording' : 'Record'}</span>
          </button>
          <button className="rail-icon-btn" onClick={props.onCopy} title="Copy latest answer (C)">
            <CopyIcon />
            <span>Copy</span>
          </button>
          <button className="rail-icon-btn" onClick={props.onClear} title="Clear history (F4)">
            <TrashIcon />
            <span>Clear</span>
          </button>
        </>
      )}

      {mode === 'meeting' && (
        <>
          <button className="rail-icon-btn" onClick={props.onPause} disabled={!listening} title="Pause meeting">
            <PauseIcon />
            <span>Pause</span>
          </button>
          <button className="rail-icon-btn" onClick={props.onMark} title="Mark last line as action">
            <FlagIcon />
            <span>Mark Action</span>
          </button>
          <button className="rail-icon-btn" onClick={props.onExport} title="Export transcript + summary as PDF">
            <PdfIcon />
            <span>Export PDF</span>
          </button>
        </>
      )}

      {mode === 'translate' && (
        <>
          <button
            className="rail-icon-btn rail-flip"
            onClick={props.onFlipLang}
            title="Flip translation direction. Recognition language stays in the title bar."
          >
            <SwapIcon />
            <span>{langTag(translateFrom)} ⇄ {langTag(translateTo)}</span>
          </button>
          <div className="rail-sec">
            <span className="rail-sec-label">Bilingual</span>
            <button
              className={`switch${bilingual ? ' on' : ''}`}
              onClick={props.onBilingual}
              role="switch"
              aria-checked={bilingual}
              title="Show original and translation together"
            />
          </div>
          <button
            className={`rail-icon-btn${recording ? ' live' : ''}`}
            onClick={props.onRecord}
            disabled={autoOn || run === 'listen'}
            title={recording ? 'Stop recording (F2)' : 'Record a clip to translate (F2)'}
          >
            <RecIcon />
            <span>{recording ? 'Recording' : 'Record'}</span>
          </button>
          <button className="rail-icon-btn" onClick={props.onCopy} title="Copy last translation">
            <CopyIcon />
            <span>Copy</span>
          </button>
        </>
      )}

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
