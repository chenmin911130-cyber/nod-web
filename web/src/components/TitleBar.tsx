import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AudioSource, Lang, PairLang, WorkspaceMode } from '../types'
import { TRANSLATE_LANGS } from '../types'
import { isWeb } from '../platform'
import { logout } from '../auth'
import { isNativeApp, nativeGo } from '../native'
import OpacityBar from './OpacityBar'
import PetTimer from './PetTimer'

interface Props {
  listening?: boolean
  mode: WorkspaceMode
  lang: Lang
  heardLang?: PairLang | null
  source: AudioSource
  opacity: number
  pinned: boolean
  systemMuted: boolean
  micMuted: boolean
  stealth: boolean
  onMode: (mode: WorkspaceMode) => void
  onLang: (lang: Lang) => void
  onSource: (s: AudioSource) => void
  onOpacity: (n: number) => void
  onPinned: (b: boolean) => void
  onSystemMuted: (muted: boolean) => void
  onMicMuted: (muted: boolean) => void
  onStealth: (on: boolean) => void
  onFullScreen: () => void
}

const LANGS: Array<{ label: string; value: Lang; name: string }> = [
  { label: 'Auto', value: 'auto', name: '' },
  ...TRANSLATE_LANGS.map((l) => ({ label: l.tag, value: l.id as Lang, name: l.name })),
]

const MODES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: 'meeting', label: 'AI Listening Assistant' },
  { id: 'translate', label: 'Translate' },
]

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

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function Chevron() {
  return (
    <svg width="8" height="6" viewBox="0 0 8 6" fill="none" aria-hidden="true">
      <path d="M1 1.2L4 4.4L7 1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function TitleBar(props: Props) {
  const { mode, lang, heardLang, source, opacity, pinned, systemMuted, micMuted, stealth } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const langRef = useRef<HTMLDivElement>(null)
  const currentLang = LANGS.find((l) => l.value === lang) ?? LANGS[0]
  const heardTag = heardLang ? TRANSLATE_LANGS.find((l) => l.id === heardLang)?.tag : ''
  const langLabel = lang === 'auto' && heardTag ? `Auto · ${heardTag}` : currentLang.label

  useEffect(() => {
    if (!menuOpen && !langOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuOpen && !menuRef.current?.contains(t)) setMenuOpen(false)
      if (langOpen && !langRef.current?.contains(t)) setLangOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen, langOpen])

  useEffect(() => {
    setMenuOpen(false)
    setLangOpen(false)
  }, [mode])

  useLayoutEffect(() => {
    if (!langOpen) return
    const menu = langRef.current?.querySelector('.lang-menu')
    if (!(menu instanceof HTMLElement)) return
    const pad = 10
    const r = menu.getBoundingClientRect()
    let dx = 0
    if (r.left < pad) dx = pad - r.left
    else if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right
    menu.style.transform = dx ? `translateX(${dx}px)` : ''
  }, [langOpen])

  return (
    <div className="titlebar">
      {isWeb && !isNativeApp() ? (
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
        {MODES.map((m) => {
          const selected = (mode === 'interview' ? 'meeting' : mode) === m.id
          return (
          <button
            key={m.id}
            role="tab"
            aria-selected={selected}
            className={`mode-pill${selected ? ' active' : ''}`}
            onClick={() => props.onMode(m.id)}
          >
            <span className="mode-pill-full">{m.label}</span>
            <span className="mode-pill-short">{m.id === 'meeting' ? 'Listen' : 'Translate'}</span>
          </button>
          )
        })}
      </div>

      <div className="titlebar-right no-drag">
        <PetTimer listening={Boolean(props.listening)} />
        {mode !== 'translate' && (
        <div className="lang-pills" ref={langRef}>
          <button
            type="button"
            className={`lang-select-btn${langOpen ? ' open' : ''}`}
            aria-haspopup="listbox"
            aria-expanded={langOpen}
            aria-label="Speech recognition language"
            title={
              currentLang.value === 'auto'
                ? 'Speech recognition · Auto'
                : `Speech recognition · ${currentLang.name}`
            }
            onClick={() => {
              setLangOpen((v) => !v)
              setMenuOpen(false)
            }}
          >
            <span>{langLabel}</span>
            <Chevron />
          </button>
          {langOpen && (
            <div className="lang-menu" role="listbox" aria-label="Speech recognition language">
              <div className="lang-menu-hint">Speech recognition</div>
              {LANGS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  role="option"
                  aria-selected={lang === l.value}
                  className={`lang-menu-item${lang === l.value ? ' active' : ''}`}
                  onClick={() => {
                    props.onLang(l.value)
                    setLangOpen(false)
                  }}
                >
                  <span className="lang-menu-tag">{l.label}</span>
                  {l.name ? <span className="lang-menu-name">{l.name}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
        )}

        <div className="tb-icons">
          {isWeb ? (
            <button
              type="button"
              className={`tb-icon src-btn${micMuted ? ' muted' : ' on'}`}
              onClick={() => props.onMicMuted(!micMuted)}
              title={micMuted ? 'Unmute microphone' : 'Mute microphone'}
              aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={!micMuted}
            >
              {micMuted ? <SourceOffIcon /> : <SourceIcon />}
            </button>
          ) : (
            <button
              className={`tb-icon src-btn${source === 'both' ? ' on' : ' muted'}`}
              onClick={() => props.onSource(source === 'both' ? 'system' : 'both')}
              title={
                source === 'both'
                  ? 'Microphone on — click to mute'
                  : 'Microphone muted — click to unmute'
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

          <div className="tb-more" ref={menuRef}>
            <button
              className={`tb-icon more-btn${menuOpen ? ' on' : ''}`}
              onClick={() => {
                setMenuOpen((v) => !v)
                setLangOpen(false)
              }}
              title="Settings"
              aria-expanded={menuOpen}
            >
              <SettingsIcon />
            </button>
            {menuOpen && (
              <div className="tb-menu">
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
                {isWeb && (
                  <>
                    <a className="tb-menu-action" href="/account">
                      Account
                    </a>
                    <button
                      className="tb-menu-action"
                      onClick={() => {
                        setMenuOpen(false)
                        void logout().finally(() => {
                          nativeGo(isNativeApp() ? '/login' : '/?signout=1')
                        })
                      }}
                    >
                      Sign out
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
