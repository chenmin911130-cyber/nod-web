import type { RunState } from '../types'
import Waveform from './Waveform'

interface Props {
  run: RunState
  status: string
  extra?: string
}

const DOT_COLOR: Record<RunState, string> = {
  idle: '#34d399',
  record: '#ffc107',
  listen: '#22d3ee',
  think: '#a78bfa',
}

const STATE_TEXT: Record<RunState, string> = {
  idle: 'Ready',
  record: 'Recording',
  listen: 'Listening',
  think: 'Thinking',
}

export default function StatusBar({ run, status, extra }: Props) {
  const label = extra && (run === 'record' || run === 'listen')
    ? `${STATE_TEXT[run]} ${extra}`
    : STATE_TEXT[run]
  return (
    <div className="statusbar">
      <div className="audio-row">
        <span className="status-dot" style={{ background: DOT_COLOR[run] }} />
        <span className="audio-text">{label}</span>
        {(run === 'record' || run === 'listen') && <Waveform active />}
      </div>
      <div className="status-line">{status}</div>
    </div>
  )
}
