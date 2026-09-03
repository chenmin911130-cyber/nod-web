import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Lang, PairLang, TranslatePair } from '../types'
import { TRANSLATE_LANGS } from '../types'
import type { AttachPayload, LocalAttach } from '../attach'
import { toPayload } from '../attach'
import PromptAttach from './PromptAttach'
import EmptyState from './EmptyState'
import { ttsAutoShouldConfirm, type TtsMode, type TtsVoice } from '../tts'
import { usePhoneChrome } from '../phoneChrome'
import { IPHONE_COPY, translateFromChip, translateSourceTag, translateToChip } from '../iphoneCopy'

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
  speaking?: boolean
  onStopSpeech?: () => void
  voiceChrome?: ReactNode
  actions?: ReactNode
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

function EarIcon() {
  return (
    <svg className="iphone-tr-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8.2 2.4c-2 0-3.6 1.6-3.6 4.2v1.8c0 1.2.5 2 .9 2.6.3.4.5.9.3 1.4-.2.6-.8 1-1.5 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8.2 2.4c1.7 0 3.2 1.3 3.2 3.4v2.2c0 1.5-.6 2.4-1.2 3-.5.5-.8 1.1-.6 1.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg className="iphone-tr-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h9.2M8.8 4.4 13 8l-4.2 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NativeTranslateCard({
  ts,
  source,
  sourceTag,
  target,
  targetPending = false,
  targetFailed = false,
  spoken,
  speaking,
  onCopyOriginal,
  onCopyTranslation,
  onSpeak,
  onStop,
  onRetry,
}: {
  ts: string
  source: string
  sourceTag: string
  target: string
  targetPending?: boolean
  targetFailed?: boolean
  spoken?: string
  speaking?: boolean
  onCopyOriginal?: () => void
  onCopyTranslation?: () => void
  onSpeak?: () => void
  onStop?: () => void
  onRetry?: () => void
}) {
  const sourceBody = (
    <span className="tr-text">
      {source}
      {sourceTag ? <span className="tr-lang-chip">{sourceTag}</span> : null}
    </span>
  )
  return (
    <div className={`tr-pair iphone-tr-card${ts === 'live' ? ' live' : ''}`}>
      <span className="meet-ts">{ts}</span>
      <div className="iphone-tr-source">
        {onCopyOriginal ? (
          <button type="button" className="tr-copy-hit" onClick={onCopyOriginal} title="Copy original">
            {sourceBody}
          </button>
        ) : (
          sourceBody
        )}
      </div>
      {spoken ? (
        <button
          type="button"
          className={`tr-speak${speaking ? ' stop' : ''}`}
          onClick={() => (speaking ? onStop?.() : onSpeak?.())}
          title={speaking ? 'Stop' : 'Play'}
          aria-label={speaking ? 'Stop speech' : 'Play translation'}
        >
          {speaking ? <LineStopIcon /> : <LinePlayIcon />}
        </button>
      ) : (
        <span className="iphone-tr-play-slot" aria-hidden="true" />
      )}
      <div className={`iphone-tr-target${targetPending ? ' pending' : ''}${targetFailed ? ' failed' : ''}`}>
        {onCopyTranslation ? (
          <button
            type="button"
            className="tr-copy-hit"
            onClick={onCopyTranslation}
            title={targetPending ? undefined : 'Copy translation'}
            disabled={targetPending}
          >
            <span className="tr-text">{target}</span>
          </button>
        ) : (
          <span className="tr-text">{target}</span>
        )}
        {targetFailed && onRetry ? (
          <button type="button" className="tr-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  )
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3.2 9.1 14.6 3.4 8.4 14.6l-.8-5.1L3.2 9.1z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function LineStopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />
    </svg>
  )
}

function LinePlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 3.4v9.2L13 8 5 3.4z" fill="currentColor" />
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
  speaking = false,
  onStopSpeech,
  voiceChrome,
  actions,
}: Props) {
  const native = usePhoneChrome()
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<LocalAttach[]>([])
  const [autoAsk, setAutoAsk] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const requestTtsMode = (mode: TtsMode) => {
    if (ttsAutoShouldConfirm(ttsMode, mode)) {
      setAutoAsk(true)
      return
    }
    setAutoAsk(false)
    onTtsMode(mode)
  }

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

  const toolbar = (
        <div className="tr-toolbar">
          <div className="tr-head-row">
          <label className={`tr-col-head tr-to-head tr-from-head${native ? ' iphone-tr-chip' : ''}`}>
            {native ? <EarIcon /> : null}
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
              <option value="auto">{native ? IPHONE_COPY.hearAnything : 'Auto · detect'}</option>
              {TRANSLATE_LANGS.map((l) => (
                <option key={l.id} value={l.id}>{native ? translateFromChip(l.id) : `${l.tag} · ${l.name}`}</option>
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
          <label className={`tr-col-head tr-to-head${native ? ' iphone-tr-chip to' : ''}`}>
            {native ? <ArrowIcon /> : null}
            <select
              className="tr-to-select"
              value={to}
              onChange={(e) => onTranslateTo(e.target.value as PairLang)}
              title="Language of the translated captions"
              aria-label="To"
            >
              {TRANSLATE_LANGS.map((l) => (
                <option key={l.id} value={l.id}>{native ? translateToChip(l.id) : `${l.tag} · ${l.name}`}</option>
              ))}
            </select>
          </label>
          </div>
          <div className="tr-voice-row">
            <button
              type="button"
              className={`tr-voice-btn labeled${ttsMode === 'tap' ? ' on' : ''}`}
              onClick={() => requestTtsMode('tap')}
              title="Tap a line to play"
              aria-label="Tap to play"
            >
              <TapPlayIcon />
              <span>Tap</span>
            </button>
            <button
              type="button"
              className={`tr-voice-btn labeled${ttsMode === 'live' ? ' on' : ''}`}
              onClick={() => requestTtsMode('live')}
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
            {speaking ? (
              <button
                type="button"
                className="tr-voice-btn labeled on tr-stop"
                onClick={() => onStopSpeech?.()}
                title="Stop speech"
                aria-label="Stop speech"
              >
                <LineStopIcon />
                <span>Stop</span>
              </button>
            ) : null}
            {voiceChrome ? (
              <>
                <span className="tr-voice-split" aria-hidden="true" />
                {voiceChrome}
              </>
            ) : null}
            {queued > 0 ? <span className="tr-queued">{queued} queued</span> : null}
          </div>
        </div>
  )

  return (
    <div className="main translate-main">
      {native ? (
        <div className="iphone-stack">
          {actions}
          {toolbar}
        </div>
      ) : toolbar}
      <div className="tr-sheet">
        <div className="tr-body">
          {empty ? (
            <EmptyState
              compact
              title={native ? IPHONE_COPY.emptyTranslate : 'Start Listen or type a line.'}
              sub={native ? '' : 'Spoken captions show up here.'}
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
                const spoken = (p.translation && !p.failed ? p.translation : p.original).trim()
                if (native) {
                  return (
                    <NativeTranslateCard
                      key={p.id}
                      ts={p.ts}
                      source={p.original}
                      sourceTag={translateSourceTag({ from: p.from, locked: from, heard: heardFrom })}
                      target={status}
                      targetPending={!p.translation}
                      targetFailed={!!p.failed}
                      spoken={spoken}
                      speaking={speaking}
                      onCopyOriginal={() => onCopyField(p, 'original')}
                      onCopyTranslation={p.translation ? () => onCopyField(p, 'translation') : undefined}
                      onSpeak={() => onSpeak(spoken)}
                      onStop={onStopSpeech}
                      onRetry={p.failed ? () => onRetry(p.id) : undefined}
                    />
                  )
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
                      </button>
                      {p.original.trim() ? (
                        <button
                          type="button"
                          className={`tr-speak${speaking ? ' stop' : ''}`}
                          onClick={() => (speaking ? onStopSpeech?.() : onSpeak(p.original))}
                          title={speaking ? 'Stop' : 'Play'}
                          aria-label={speaking ? 'Stop speech' : 'Play original'}
                        >
                          {speaking ? <LineStopIcon /> : <LinePlayIcon />}
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
                          className={`tr-speak${speaking ? ' stop' : ''}`}
                          onClick={() => (speaking ? onStopSpeech?.() : onSpeak(p.translation))}
                          title={speaking ? 'Stop' : 'Play'}
                          aria-label={speaking ? 'Stop speech' : 'Play translation'}
                        >
                          {speaking ? <LineStopIcon /> : <LinePlayIcon />}
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
              {partial && native ? (
                <NativeTranslateCard
                  ts="live"
                  source={partial}
                  sourceTag={translateSourceTag({ locked: from, heard: heardFrom })}
                  target="Listening…"
                  targetPending
                />
              ) : partial ? (
                <div className="tr-pair live">
                  <div className="tr-cell origin">
                    <span className="meet-ts">live</span>
                    <span className="tr-text">{partial}</span>
                  </div>
                  <div className="tr-cell target pending">
                    <span>Listening…</span>
                  </div>
                </div>
              ) : null}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {native ? (
        <div className="iphone-tr-prompt">
          <input
            className="prompt-input"
            placeholder={IPHONE_COPY.typeToTranslate}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <button
            type="button"
            className="iphone-tr-send"
            onClick={submit}
            disabled={!input.trim() && files.length === 0}
            aria-label={IPHONE_COPY.typeToTranslate}
          >
            <SendIcon />
          </button>
        </div>
      ) : (
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
      )}
      {autoAsk ? (
        <div className="consent-mask" onClick={() => setAutoAsk(false)}>
          <div
            className="consent-card confirm-card"
            role="dialog"
            aria-labelledby="tts-auto-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="tts-auto-title">Turn on Auto play?</h2>
            <p>Each new translation will play out loud. You can switch back to Tap anytime.</p>
            <div className="confirm-actions">
              <button className="confirm-keep" type="button" onClick={() => setAutoAsk(false)} autoFocus>
                Keep Tap
              </button>
              <button
                className="confirm-go"
                type="button"
                onClick={() => {
                  setAutoAsk(false)
                  onTtsMode('live')
                }}
              >
                Turn on Auto
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
