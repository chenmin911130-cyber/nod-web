import { useEffect, useRef, useState } from 'react'
import type { MeetingLine } from '../types'
import type { ListeningMode } from '../listening'
import { LISTENING_MODES } from '../listening'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import { AnswerContent } from './AnswerContent'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'

interface Props {
  lines: MeetingLine[]
  captions?: Record<string, string>
  showCaptions?: boolean
  onToggleCaptions?: (on: boolean) => void
  listeningMode?: ListeningMode
  partial: string
  summary: string
  busy: boolean
  elapsedLabel: string
  listening: boolean
  onGenerate: (note?: string, files?: AttachPayload[], intent?: 'notes' | 'ask') => void
}

function Sparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.2l1.05 5.1L16.3 7.4 11.05 8.7 10 13.8 8.95 8.7 3.7 7.4l5.25-1.1L10 1.2z" />
      <path d="M15.6 11.6l.5 2.05 2.05.5-2.05.5-.5 2.05-.5-2.05-2.05-.5 2.05-.5.5-2.05z" />
    </svg>
  )
}

const CHIPS = [
  { label: 'Summarize', text: 'Summarize this session.' },
  { label: 'Key points', text: 'What are the key points?' },
  { label: 'Action items', text: 'List action items, owners, and deadlines if they were said.' },
]

export default function MeetingPane({
  lines,
  captions = {},
  showCaptions = false,
  onToggleCaptions,
  listeningMode = 'meeting',
  partial,
  summary,
  busy,
  elapsedLabel,
  listening,
  onGenerate,
}: Props) {
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<LocalAttach[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const modeLabel = LISTENING_MODES.find((m) => m.id === listeningMode)?.label ?? 'Meeting'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [lines, partial])

  const submit = (intent: 'notes' | 'ask' = 'ask') => {
    if (busy) return
    const t = input.trim()
    if (!t && files.length === 0) {
      onGenerate(undefined, undefined, 'notes')
      return
    }
    onGenerate(t || undefined, files.length ? toPayload(files) : undefined, intent)
    setInput('')
    setFiles([])
  }

  const empty = lines.length === 0 && !partial

  return (
    <div className="main meeting-main">
      <div className="meet-transcript">
        <div className="kicker-row">
          <div className="kicker">Live transcript · {modeLabel}</div>
          <div className="meet-timer">{listening ? elapsedLabel : elapsedLabel === '00:00:00' ? '' : elapsedLabel}</div>
        </div>
        {onToggleCaptions && (
          <label className="site-check" style={{ margin: '0 0 8px', fontSize: 12, color: '#9bb0c8' }}>
            <input type="checkbox" checked={showCaptions} onChange={(e) => onToggleCaptions(e.target.checked)} />
            <span>Optional translation</span>
          </label>
        )}
        <div className="meet-scroll" ref={scrollRef}>
          {empty ? (
            <EmptyState
              compact
              title="What are you listening to?"
              sub="Choose a mode or start listening. Transcript stays on the left."
              shortcuts={[{ key: 'F3', label: 'Start' }]}
            />
          ) : (
            lines.map((ln) => (
              <div key={ln.id} className={`meet-line${ln.marked ? ' marked' : ''}`}>
                <span className="meet-ts">{ln.ts}</span>
                <span className="meet-text">
                  {ln.marked && <span className="meet-flag">Action · </span>}
                  {ln.text}
                  {showCaptions && captions[ln.id] ? <span className="meet-caption">{captions[ln.id]}</span> : null}
                </span>
              </div>
            ))
          )}
          {partial && (
            <div className="meet-line live">
              <span className="meet-ts">live</span>
              <span className="meet-text">{partial}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="meet-summary">
        <div className="kicker">AI notes · {modeLabel}</div>
        <div className="meet-summary-body">
          {summary ? (
            <AnswerContent answer={summary} base="ms" />
          ) : (
            <div className="answer-empty">
              {busy ? 'Writing notes…' : 'Generate notes for this mode, or ask Nod about what you heard.'}
            </div>
          )}
        </div>
      </div>

      <div className="ask-chips">
        {CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className="ask-chip"
            disabled={busy}
            onClick={() => onGenerate(chip.text, undefined, 'ask')}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <PromptAttach files={files} onChange={setFiles} disabled={busy}>
        <input
          className="prompt-input"
          placeholder="Ask Nod anything about what you heard..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit('ask')
          }}
        />
        <button className="gen-btn" onClick={() => submit(input.trim() || files.length ? 'ask' : 'notes')} disabled={busy}>
          <Sparkle />
          {input.trim() || files.length ? 'Ask Nod' : 'Notes'}
        </button>
      </PromptAttach>
    </div>
  )
}
