import type { CaptureState, EngineState } from '../types'
import Waveform from './Waveform'

interface Props {
  capture: CaptureState
  engine: EngineState
  status: string
  extra?: string
}

const DOT_COLOR: Record<CaptureState, string> = {
  off: '#34d399',
  listening: '#22d3ee',
  recording: '#ffc107',
  paused: '#ffc107',
}

const STATE_TEXT: Record<CaptureState, string> = {
  off: 'Ready',
  listening: 'Listening',
  recording: 'Recording',
  paused: 'Paused',
}

export default function StatusBar({ capture, engine, status, extra }: Props) {
  const thinking = engine !== 'idle'
  const live = capture === 'listening' || capture === 'recording'
  const label = thinking
    ? 'Thinking'
    : extra && live
      ? `${STATE_TEXT[capture]} ${extra}`
      : STATE_TEXT[capture]
  const dot = thinking ? '#a78bfa' : DOT_COLOR[capture]
  return (
    <div className="statusbar">
      <div className="audio-row">
        <span className="status-dot" style={{ background: dot }} />
        <span className="audio-text">{label}</span>
        {live && <Waveform active />}
      </div>
      <div className="status-line">{status}</div>
    </div>
  )
}
