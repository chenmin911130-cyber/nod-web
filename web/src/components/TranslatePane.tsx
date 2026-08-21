import { useEffect, useRef, useState } from 'react'
import type { PairLang, TranslatePair } from '../types'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'

interface Props {
  pairs: TranslatePair[]
  partial: string
  busy: boolean
  bilingual: boolean
  from: PairLang
  to: PairLang
  onTranslate: (text: string, files?: AttachPayload[]) => void
  onCopyPair: (pair: TranslatePair) => void
}

function langTag(code: PairLang): string {
  return code === 'zh' ? 'CH' : 'EN'
}

function Sparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.2l1.05 5.1L16.3 7.4 11.05 8.7 10 13.8 8.95 8.7 3.7 7.4l5.25-1.1L10 1.2z" />
      <path d="M15.6 11.6l.5 2.05 2.05.5-2.05.5-.5 2.05-.5-2.05-2.05-.5 2.05-.5.5-2.05z" />
    </svg>
  )
}

export default function TranslatePane({ pairs, partial, busy, bilingual, from, to, onTranslate, onCopyPair }: Props) {
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<LocalAttach[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [pairs, partial])

  const submit = () => {
    const t = input.trim()
    if (busy || (!t && files.length === 0)) return
    onTranslate(t, files.length ? toPayload(files) : undefined)
    setInput('')
    setFiles([])
  }

  const empty = pairs.length === 0 && !partial
  const last = pairs[pairs.length - 1]

  return (
    <div className="main translate-main">
      <div className="kicker">Captions · {langTag(from)} → {langTag(to)}</div>
      <div className={`tr-sheet${bilingual ? '' : ' single'}`}>
        <div className="tr-head-row">
          {bilingual && <div className="tr-col-head">{langTag(from)}</div>}
          <div className="tr-col-head">{langTag(to)}</div>
        </div>
        <div className="tr-body">
          {empty ? (
            <EmptyState
              compact
              title="No captions yet"
              sub="Start listening, or type a line to translate"
              shortcuts={[
                { key: 'F3', label: 'Listen' },
                { key: 'F2', label: 'Record' },
              ]}
            />
          ) : (
            <>
              {pairs.map((p) => {
                const pending = !p.translation && busy && last?.id === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="tr-pair"
                    onClick={() => onCopyPair(p)}
                    title="Copy this translation"
                  >
                    {bilingual && (
                      <div className="tr-cell">
                        <span className="meet-ts">{p.ts}</span>
                        <span>{p.original}</span>
                      </div>
                    )}
                    <div className={`tr-cell${p.translation ? '' : ' pending'}`}>
                      {!bilingual && <span className="meet-ts">{p.ts}</span>}
                      <span>{p.translation || (pending ? 'Translating…' : 'Waiting…')}</span>
                    </div>
                  </button>
                )
              })}
              {partial && (
                <div className="tr-pair live">
                  {bilingual && (
                    <div className="tr-cell">
                      <span className="meet-ts">live</span>
                      <span>{partial}</span>
                    </div>
                  )}
                  <div className="tr-cell pending">
                    {!bilingual && <span className="meet-ts">live</span>}
                    <span>Listening…</span>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <PromptAttach files={files} onChange={setFiles} disabled={busy}>
        <input
          className="prompt-input"
          placeholder="Type to translate..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="gen-btn" onClick={submit} disabled={busy || (!input.trim() && files.length === 0)}>
          <Sparkle />
          Translate
        </button>
      </PromptAttach>
    </div>
  )
}
