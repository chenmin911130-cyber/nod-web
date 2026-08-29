import { useEffect, useRef, useState } from 'react'
import type { AudioSource, Lang, PairLang, TranslatePair } from '../types'
import { TRANSLATE_LANGS } from '../types'
import { isWeb } from '../platform'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'

interface Props {
  pairs: TranslatePair[]
  partial: string
  bindId: string
  bilingual: boolean
  to: PairLang
  from: Lang
  heardFrom?: PairLang | null
  source: AudioSource
  onTranslate: (text: string, files?: AttachPayload[]) => void
  onTranslateTo: (lang: PairLang) => void
  onTranslateFrom: (lang: Lang) => void
  onSwap: () => void
  onCopyField: (pair: TranslatePair, field: 'original' | 'translation') => void
  onRetry: (id: string) => void
}

function langTag(code: PairLang): string {
  return TRANSLATE_LANGS.find((l) => l.id === code)?.tag ?? code.toUpperCase()
}

function SwapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.2 5.2h9.1M9.6 2.8l2.7 2.4-2.7 2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.8 10.8H3.7M6.4 8.4 3.7 10.8l2.7 2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Sparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.2l1.05 5.1L16.3 7.4 11.05 8.7 10 13.8 8.95 8.7 3.7 7.4l5.25-1.1L10 1.2z" />
      <path d="M15.6 11.6l.5 2.05 2.05.5-2.05.5-.5 2.05-.5-2.05-2.05-.5 2.05-.5.5-2.05z" />
    </svg>
  )
}

export default function TranslatePane({
  pairs,
  partial,
  bindId,
  bilingual,
  to,
  from,
  heardFrom,
  source,
  onTranslate,
  onTranslateTo,
  onTranslateFrom,
  onSwap,
  onCopyField,
  onRetry,
}: Props) {
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<LocalAttach[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [pairs, partial])

  const submit = () => {
    const t = input.trim()
    if (!t && files.length === 0) return
    onTranslate(t, files.length ? toPayload(files) : undefined)
    setInput('')
    setFiles([])
  }

  const empty = pairs.length === 0 && !partial
  const queued = pairs.filter((p) => !p.translation && !p.failed && p.id !== bindId).length
  const sourceHint = isWeb
    ? 'Browser mic'
    : source === 'both'
      ? 'System + mic'
      : 'System audio'

  const fromTag = from === 'auto' ? (heardFrom ? langTag(heardFrom) : 'Auto') : langTag(from)
  const sameLang = from !== 'auto' && from === to

  return (
    <div className="main translate-main">
      <div className="kicker">
        Captions · {fromTag} → {langTag(to)}
        {sameLang ? ' · same language' : ''}
        {queued > 0 ? ` · ${queued} queued` : ''}
        <span className="kicker-hint"> · F3 {sourceHint} · F2 your mic</span>
      </div>
      <div className={`tr-sheet${bilingual ? '' : ' single'}`}>
        <div className="tr-head-row">
          <label className="tr-col-head tr-to-head tr-from-head">
            <span>From</span>
            <select
              className="tr-to-select"
              value={from}
              onChange={(e) => onTranslateFrom(e.target.value as Lang)}
              title="Speech to recognize. Lock English to ignore other languages — they will not appear."
            >
              <option value="auto">Auto · detect</option>
              {TRANSLATE_LANGS.map((l) => (
                <option key={l.id} value={l.id}>{l.tag} · {l.name} only</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="tr-swap"
            onClick={onSwap}
            title={from === 'auto' ? 'Lock From to current To and flip captions' : 'Swap From and To'}
            aria-label="Swap From and To"
          >
            <SwapIcon />
          </button>
          <label className="tr-col-head tr-to-head">
            <span>To</span>
            <select
              className="tr-to-select"
              value={to}
              onChange={(e) => onTranslateTo(e.target.value as PairLang)}
              title="Language of the translated captions"
            >
              {TRANSLATE_LANGS.map((l) => (
                <option key={l.id} value={l.id}>{l.tag} · {l.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="tr-body">
          {empty ? (
            <EmptyState compact title="Make communication simpler." />
          ) : (
            <>
              {pairs.map((p) => {
                const pending = !p.translation
                const active = pending && !p.failed && p.id === bindId
                let status = p.translation
                if (!status) {
                  if (p.failed) status = 'Failed'
                  else if (active) status = 'Translating…'
                  else status = 'Waiting…'
                }
                return (
                  <div key={p.id} className="tr-pair">
                    {bilingual && (
                      <button
                        type="button"
                        className="tr-cell"
                        onClick={() => onCopyField(p, 'original')}
                        title="Copy original"
                      >
                        <span className="meet-ts">{p.ts}</span>
                        <span>{p.original}</span>
                        {p.from ? <span className="tr-lang-chip">{langTag(p.from)}</span> : null}
                      </button>
                    )}
                    <div className={`tr-cell${p.translation ? '' : ' pending'}${p.failed ? ' failed' : ''}`}>
                      {!bilingual && <span className="meet-ts">{p.ts}</span>}
                      <button
                        type="button"
                        className="tr-copy-hit"
                        onClick={() => onCopyField(p, 'translation')}
                        title={p.translation ? 'Copy translation' : undefined}
                        disabled={!p.translation}
                      >
                        <span>{status}</span>
                        {p.passthrough && p.translation ? <span className="tr-lang-chip">Same lang</span> : null}
                        {p.to && p.to !== to && p.translation ? (
                          <span className="tr-lang-chip">{langTag(p.to)}</span>
                        ) : null}
                      </button>
                      {p.failed ? (
                        <button type="button" className="tr-retry" onClick={() => onRetry(p.id)}>
                          Retry
                        </button>
                      ) : null}
                    </div>
                  </div>
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

      <PromptAttach files={files} onChange={setFiles}>
        <input
          className="prompt-input"
          placeholder="Type to translate..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="gen-btn" onClick={submit} disabled={!input.trim() && files.length === 0}>
          <Sparkle />
          Translate
        </button>
      </PromptAttach>
    </div>
  )
}
