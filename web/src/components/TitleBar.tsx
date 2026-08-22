import { useEffect, useRef, useState } from 'react'
import type { AudioSource, Lang, ModelDef, WorkspaceMode } from '../types'
import { isWeb } from '../platform'
import OpacityBar from './OpacityBar'

interface Props {
  mode: WorkspaceMode
  models: ModelDef[]
  llm: { provider: string; model: string }
  lang: Lang
  source: AudioSource
  opacity: number
  pinned: boolean
  systemMuted: boolean
  stealth: boolean
  onMode: (mode: WorkspaceMode) => void
  onModel: (provider: string, model: string) => void
  onLang: (lang: Lang) => void
  onSource: (s: AudioSource) => void
  onOpacity: (n: number) => void
  onPinned: (b: boolean) => void
  onSystemMuted: (muted: boolean) => void
  onStealth: (on: boolean) => void
  onFullScreen: () => void
  quotaLabel?: string
}

const LANGS: Array<{ label: string; value: Lang }> = [
  { label: 'Auto', value: 'auto' },
  { label: 'CH', value: 'zh' },
  { label: 'EN', value: 'en' },
]

const MODES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: 'interview', label: 'Interview' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'translate', label: 'Translate' },
]

function shortModelLabel(label: string): string {
  const cleaned = label.replace(/\s*[·•|].*$/, '').trim()
  const shortened = cleaned.replace(/\bV\d+\b/gi, '').replace(/\s+/g, ' ').trim()
  return shortened || label
}

function NodLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path d="M26 88 V32 A13 13 0 0 1 52 32 L78 58" stroke="#f5f8ff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M58 38 Q66 29 81 34 V60" stroke="#f5f8ff" strokeWidth="9" strokeLinecap="round" />
      <circle cx="81" cy="70" r="4.5" fill="#22d3ee" />
    </svg>
  )
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.6 8.2v3.6h2L9.2 15V5L5.6 8.2H3.6z" />
      <path d="M12 7.3a3.4 3.4 0 0 1 0 5.4" />
      <path d="M14.5 5.4a6 6 0 0 1 0 9.2" />
    </svg>
  )
}

function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.6 8.2v3.6h2L9.2 15V5L5.6 8.2H3.6z" />
      <line x1="12" y1="6.2" x2="17.2" y2="13.8" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.35" />
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
  )
}

function SourceIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2.5" width="6" height="10" rx="3" />
      <path d="M5 10.2a5 5 0 0 0 10 0" />
      <line x1="10" y1="15.2" x2="10" y2="17.2" />
      <line x1="7" y1="17.2" x2="13" y2="17.2" />
    </svg>
  )
}

function SourceOffIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2.5" width="6" height="10" rx="3" />
      <path d="M5 10.2a5 5 0 0 0 10 0" />
      <line x1="10" y1="15.2" x2="10" y2="17.2" />
      <line x1="7" y1="17.2" x2="13" y2="17.2" />
      <line x1="4" y1="3.5" x2="16" y2="16.5" />
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

export default function TitleBar(props: Props) {
  const { mode, models, llm, lang, source, opacity, pinned, systemMuted, stealth } = props
  const curIdx = models.findIndex((m) => m.provider === llm.provider && m.model === llm.model)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  useEffect(() => {
    setMenuOpen(false)
  }, [mode])

  return (
    <div className="titlebar">
      {isWeb ? (
        <a href="/" className="brand no-drag" title="Product page">
          <NodLogo />
          <span className="brand-white">Nod</span>
        </a>
      ) : (
        <div className="brand no-drag">
          <NodLogo />
          <span className="brand-white">Nod</span>
        </div>
      )}

      <div className="mode-pills no-drag" role="tablist" aria-label="Workspace mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            className={`mode-pill${mode === m.id ? ' active' : ''}`}
            onClick={() => props.onMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="titlebar-right no-drag">
        {mode !== 'translate' && (
          <div className="lang-pills" role="group" aria-label="Speech recognition language">
            {LANGS.map((l) => (
              <button
                key={l.value}
                className={`lang-pill${lang === l.value ? ' active' : ''}`}
                onClick={() => props.onLang(l.value)}
                title={
                  l.value === 'auto'
                    ? 'Auto: answer in the same language as the question'
                    : l.value === 'zh'
                      ? 'Force Chinese answers'
                      : 'Force English answers'
                }
              >
                {l.label}
              </button>
            ))}
          </div>
        )}

        <div className="tb-icons">
          {isWeb ? (
            <span className="tb-icon src-btn on" title="Browser microphone → AssemblyAI cloud STT">
              <SourceIcon />
            </span>
          ) : (
            <button
              className={`tb-icon src-btn${source === 'both' ? ' on' : ' muted'}`}
              onClick={() => props.onSource(source === 'both' ? 'system' : 'both')}
              title={
                source === 'both'
                  ? 'Microphone on — click to turn off'
                  : 'Microphone off — click to capture your mic'
              }
            >
              {source === 'both' ? <SourceIcon /> : <SourceOffIcon />}
            </button>
          )}

          {!isWeb && (
            <button
              className={`tb-icon mic-btn${systemMuted ? ' muted' : ''}`}
              onClick={() => props.onSystemMuted(!systemMuted)}
              title={
                systemMuted
                  ? 'System audio off — click to capture speaker output'
                  : 'System audio on — click to stop capturing speaker output'
              }
            >
              {systemMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
            </button>
          )}

          {!isWeb && (
            <button
              className={`tb-icon pin-btn${pinned ? ' on' : ''}`}
              onClick={() => props.onPinned(!pinned)}
              title={pinned ? 'Pinned on top' : 'Pin on top'}
            >
              <PinIcon />
            </button>
          )}

          {isWeb && (
            <a className="lang-pill" href="/account" title="Account and remaining quota">
              {props.quotaLabel || 'Account'}
            </a>
          )}

          <div className="tb-more" ref={menuRef}>
            <button
              className={`tb-icon more-btn${menuOpen ? ' on' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              title="Settings"
              aria-expanded={menuOpen}
            >
              <MoreIcon />
            </button>
            {menuOpen && (
              <div className="tb-menu">
                <label className="tb-menu-row">
                  <span>Model</span>
                  <select
                    className="combo combo-model"
                    value={curIdx >= 0 ? String(curIdx) : '0'}
                    onChange={(e) => {
                      const m = models[Number(e.target.value)]
                      if (m) props.onModel(m.provider, m.model)
                    }}
                  >
                    {models.map((m, i) => (
                      <option key={`${m.provider}/${m.model}`} value={String(i)}>
                        {shortModelLabel(m.label)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="tb-menu-row tb-menu-opacity">
                  <span>Opacity</span>
                  <OpacityBar value={opacity} onChange={props.onOpacity} />
                </div>
                {mode === 'interview' && (
                  <>
                    {!isWeb && (
                      <button
                        className="tb-menu-action"
                        onClick={() => {
                          props.onStealth(!stealth)
                          setMenuOpen(false)
                        }}
                      >
                        {stealth ? 'Stealth on' : 'Stealth — hide from capture'}
                      </button>
                    )}
                    <button
                      className="tb-menu-action"
                      onClick={() => {
                        props.onFullScreen()
                        setMenuOpen(false)
                      }}
                    >
                      Compact view
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {!isWeb && (
          <div className="tb-win">
            <button className="win-btn" onClick={() => window.api.minimize()} title="Minimize">
              ─
            </button>
            <button className="win-btn close" onClick={() => window.api.close()} title="Close">
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
