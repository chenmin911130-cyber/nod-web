import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Lang, PairLang, TranslatePair } from '../types'
import { TRANSLATE_LANGS } from '../types'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'
import type { TtsMode, TtsVoice } from '../tts'

interface Props {
  pairs: TranslatePair[]
  partial: string
  bindId: string
  to: PairLang
  from: Lang
  heardFrom?: PairLang | null
  onTranslate: (text: string, files?: AttachPayload[]) => void
  onTranslateTo: (lang: PairLang) => void
  onTranslateFrom: (lang: Lang) => void
  onSwap: () => void
  onCopyField: (pair: TranslatePair, field: 'original' | 'translation') => void
  onRetry: (id: string) => void
  ttsMode: TtsMode
  ttsVoice: TtsVoice
  onTtsMode: (mode: TtsMode) => void
  onTtsVoice: (voice: TtsVoice) => void
  onSpeak: (text: string) => void
  voiceChrome?: ReactNode
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

function TapPlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.2" cy="8.2" r="6.1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.7 5.7v5L11.2 8.2 6.7 5.7z" fill="currentColor" />
      <path d="M12.4 13.2c.55.85 1.7 1.7 2.85 1.55M11.7 16.4c1.15.35 2.7.15 3.7-.85" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  )
}

function AutoPlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4.2 10.2a5.8 5.8 0 0 1 9.7-4.2l.4-1.7M15.8 9.8a5.8 5.8 0 0 1-9.7 4.2l-.4 1.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M13.6 3.6h2.5v2.4M6.4 16.4H3.9v-2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.2 7.3v5.4L12.6 10 8.2 7.3z" fill="currentColor" />
    </svg>
  )
}

function FemaleVoiceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.4" cy="6.2" r="2.35" stroke="currentColor" strokeWidth="1.55" />
      <path
        d="M6.15 6.4c-.7.55-1.15 1.7-1.05 2.85M10.65 6.4c.7.55 1.15 1.7 1.05 2.85M5.7 5.15c.55-1.35 1.7-2.05 2.7-2.05s2.15.7 2.7 2.05"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <path
        d="M4.85 16.6c.25-2.55 1.45-3.85 3.55-3.85s3.3 1.3 3.55 3.85"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <path d="M15.05 8.1c.85.55.85 2.05 0 2.6M16.85 7.15c1.45.95 1.45 3.55 0 4.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  )
}

function MaleVoiceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.4" cy="6.35" r="2.3" stroke="currentColor" strokeWidth="1.55" />
      <path
        d="M4.55 16.6c.35-2.85 1.7-4.15 3.85-4.15s3.5 1.3 3.85 4.15"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <path d="M15.05 8.1c.85.55.85 2.05 0 2.6M16.85 7.15c1.45.95 1.45 3.55 0 4.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  )
}

export default function TranslatePane({
  pairs,
  partial,
  bindId,
  to,
  from,
  heardFrom,
  onTranslate,
  onTranslateTo,
  onTranslateFrom,
  onSwap,
  onCopyField,
  onRetry,
  ttsMode,
  ttsVoice,
  onTtsMode,
  onTtsVoice,
  onSpeak,
  voiceChrome,
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

  return (
    <div className="main translate-main">
      <div className="tr-sheet">
        <div className="tr-toolbar">
          <div className="tr-head-row">
          <label className="tr-col-head tr-to-head tr-from-head">
            <select
              className="tr-to-select"
              value={from}
              onChange={(e) => onTranslateFrom(e.target.value as Lang)}
              title={
                heardFrom
                  ? `Speech to recognize. Hearing ${langTag(heardFrom)}. Lock a language to ignore others.`
                  : 'Speech to recognize. Lock English to ignore other languages — they will not appear.'
              }
              aria-label="From"
            >
              <option value="auto">Auto · detect</option>
              {TRANSLATE_LANGS.map((l) => (
                <option key={l.id} value={l.id}>{l.tag} · {l.name}</option>
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
            <select
              className="tr-to-select"
              value={to}
              onChange={(e) => onTranslateTo(e.target.value as PairLang)}
              title="Language of the translated captions"
              aria-label="To"
            >
              {TRANSLATE_LANGS.map((l) => (
                <option key={l.id} value={l.id}>{l.tag} · {l.name}</option>
              ))}
            </select>
          </label>
          </div>
          <div className="tr-voice-row">
            <button
              type="button"
              className={`tr-voice-btn labeled${ttsMode === 'tap' ? ' on' : ''}`}
              onClick={() => onTtsMode('tap')}
              title="Tap a line to play"
              aria-label="Tap to play"
            >
              <TapPlayIcon />
              <span>Tap</span>
            </button>
            <button
              type="button"
              className={`tr-voice-btn labeled${ttsMode === 'live' ? ' on' : ''}`}
              onClick={() => onTtsMode('live')}
              title="Play each new line automatically"
              aria-label="Auto play"
            >
              <AutoPlayIcon />
              <span>Auto</span>
            </button>
            <span className="tr-voice-split" aria-hidden="true" />
            <button
              type="button"
              className={`tr-voice-btn${ttsVoice === 'female' ? ' on' : ''}`}
              onClick={() => onTtsVoice('female')}
              title="Female voice"
              aria-label="Female voice"
            >
              <FemaleVoiceIcon />
            </button>
            <button
              type="button"
              className={`tr-voice-btn${ttsVoice === 'male' ? ' on' : ''}`}
              onClick={() => onTtsVoice('male')}
              title="Male voice"
              aria-label="Male voice"
            >
              <MaleVoiceIcon />
            </button>
            {voiceChrome ? (
              <>
                <span className="tr-voice-split" aria-hidden="true" />
                {voiceChrome}
              </>
            ) : null}
            {queued > 0 ? <span className="tr-queued">{queued} queued</span> : null}
          </div>
        </div>
        <div className="tr-body">
          {empty ? (
            <EmptyState
              compact
              title="Start Listen or type a line."
              sub="Spoken captions show up here."
            />
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
                    <div className="tr-cell origin">
                      <span className="meet-ts">{p.ts}</span>
                      <button
                        type="button"
                        className="tr-copy-hit"
                        onClick={() => onCopyField(p, 'original')}
                        title="Copy original"
                      >
                        <span className="tr-text">{p.original}</span>
                        {p.from ? <span className="tr-lang-chip">{langTag(p.from)}</span> : null}
                      </button>
                      {p.original.trim() ? (
                        <button
                          type="button"
                          className="tr-speak"
                          onClick={() => onSpeak(p.original)}
                          title="Play original"
                        >
                          Play
                        </button>
                      ) : null}
                    </div>
                    <div className={`tr-cell target${p.translation ? '' : ' pending'}${p.failed ? ' failed' : ''}`}>
                      <button
                        type="button"
                        className="tr-copy-hit"
                        onClick={() => onCopyField(p, 'translation')}
                        title={p.translation ? 'Copy translation' : undefined}
                        disabled={!p.translation}
                      >
                        <span className="tr-text">{status}</span>
                        {p.passthrough && p.translation ? <span className="tr-lang-chip">Same lang</span> : null}
                        {p.to && p.to !== to && p.translation ? (
                          <span className="tr-lang-chip">{langTag(p.to)}</span>
                        ) : null}
                      </button>
                      {p.translation && !p.failed ? (
                        <button
                          type="button"
                          className="tr-speak"
                          onClick={() => onSpeak(p.translation)}
                          title="Play translation"
                        >
                          Play
                        </button>
                      ) : null}
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
                  <div className="tr-cell origin">
                    <span className="meet-ts">live</span>
                    <span className="tr-text">{partial}</span>
                  </div>
                  <div className="tr-cell target pending">
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
