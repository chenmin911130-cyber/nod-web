import { useEffect, useRef, useState } from 'react'
import type { AudioSource, Lang, PairLang, WorkspaceMode } from '../types'
import { isWeb } from '../platform'
import { logout } from '../auth'
import { PRODUCT_NAME } from '../brand'
import { isNativeApp, nativeGo, readNativeAppBuild } from '../native'
import { usePhoneChrome } from '../phoneChrome'
import { IPHONE_COPY } from '../iphoneCopy'
import OpacityBar from './OpacityBar'
import PetTimer from './PetTimer'

export interface TitleIconsProps {
  mode: WorkspaceMode
  source: AudioSource
  opacity: number
  pinned: boolean
  systemMuted: boolean
  micMuted: boolean
  stealth: boolean
  onSource: (s: AudioSource) => void
  onOpacity: (n: number) => void
  onPinned: (b: boolean) => void
  onSystemMuted: (muted: boolean) => void
  onMicMuted: (muted: boolean) => void
  onStealth: (on: boolean) => void
  onFullScreen: () => void
  onMenuOpen?: () => void
  onOpenHistory?: () => void
  onMore?: () => void
}

interface Props {
  listening?: boolean
  elapsedMs?: number
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
  onOpenHistory?: () => void
  onMore?: () => void
  accountInitials?: string
  onAccount?: () => void
  showNew?: boolean
  onNew?: () => void
}

const MODES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: 'meeting', label: 'Listen' },
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

function BrandWordmark() {
  return (
    <span className="brand-word" aria-label={PRODUCT_NAME}>
      <span className="brand-nod">Nod</span>
      <span className="brand-cyan">
        p
        <span className="brand-i">
          <span className="brand-i-stem">ı</span>
          <svg className="brand-i-icon" width="12" height="14" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <path d="M26 88 V32 A13 13 0 0 1 52 32 L78 58" stroke="#00d2ff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M58 38 Q66 29 81 34 V60" stroke="#00d2ff" strokeWidth="9" strokeLinecap="round" />
            <circle cx="81" cy="70" r="4.5" fill="#00d2ff" />
          </svg>
        </span>
        lot
      </span>
    </span>
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

function SessionMoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="19" cy="12" r="1.7" fill="currentColor" />
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

export function TitleIcons(props: TitleIconsProps) {
  const { mode, source, opacity, pinned, systemMuted, micMuted, stealth } = props
  const phone = usePhoneChrome()
  const [menuOpen, setMenuOpen] = useState(false)
  const [appVer, setAppVer] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void readNativeAppBuild().then(setAppVer)
  }, [])

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
          type="button"
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
          type="button"
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
          type="button"
          className={`tb-icon pin-btn${pinned ? ' on' : ''}`}
          onClick={() => props.onPinned(!pinned)}
          title={pinned ? 'Pinned on top' : 'Pin on top'}
        >
          <PinIcon />
        </button>
      )}

      <div className="tb-more" ref={menuRef}>
        <button
          type="button"
          className={`tb-icon more-btn${menuOpen ? ' on' : ''}`}
          onClick={() => {
            setMenuOpen((v) => !v)
            props.onMenuOpen?.()
          }}
          title="Settings"
          aria-label="Settings"
          aria-expanded={menuOpen}
        >
          <SettingsIcon />
        </button>
        {menuOpen && (
          <div className="tb-menu">
            {!phone ? (
              <div className="tb-menu-row tb-menu-opacity">
                <span>Opacity</span>
                <OpacityBar value={opacity} onChange={props.onOpacity} />
              </div>
            ) : null}
            {!isWeb && mode === 'interview' && (
              <>
                <button
                  type="button"
                  className="tb-menu-action"
                  onClick={() => {
                    props.onStealth(!stealth)
                    setMenuOpen(false)
                  }}
                >
                  {stealth ? 'Stealth on' : 'Stealth — hide from capture'}
                </button>
                <button
                  type="button"
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
            {isWeb && !phone && (
              <>
                <div className="tb-menu-action tb-version">
                  {appVer ? `Version ${appVer}` : 'Version'}
                </div>
                <button
                  type="button"
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
  )
}

export default function TitleBar(props: Props) {
  const { mode, source, opacity, pinned, systemMuted, micMuted, stealth } = props
  const phone = usePhoneChrome()

  return (
    <div className="titlebar">
      {isWeb && !isNativeApp() ? (
        <a href="/" className="brand no-drag" title="Product page">
          <NodLogo />
          {phone ? <BrandWordmark /> : <span className="brand-white">{PRODUCT_NAME}</span>}
        </a>
      ) : (
        <div className="brand no-drag" aria-label={PRODUCT_NAME}>
          <NodLogo />
          {phone ? <BrandWordmark /> : null}
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
            <span className="mode-pill-short">{m.label}</span>
          </button>
          )
        })}
      </div>

      <div className="titlebar-right no-drag">
        {!phone && <PetTimer listening={Boolean(props.listening)} />}
        {phone ? (
          /* Avatar = Account. … = this session (PDF / Save / History / New). */
          <button
            type="button"
            className="tb-icon tb-session"
            onClick={() => props.onMore?.()}
            title={IPHONE_COPY.more}
            aria-label={IPHONE_COPY.more}
          >
            <SessionMoreIcon />
          </button>
        ) : null}
        {phone && props.showNew ? (
          <button
            type="button"
            className="tb-new"
            onClick={() => props.onNew?.()}
            title={IPHONE_COPY.moreNew}
            aria-label={IPHONE_COPY.moreNew}
          >
            <span className="tb-new-ring" aria-hidden="true">+</span>
            <span className="tb-new-label">{IPHONE_COPY.newShort}</span>
          </button>
        ) : null}
        {phone ? (
          <button
            type="button"
            className="tb-icon tb-account"
            onClick={() => props.onAccount?.()}
            title={IPHONE_COPY.accountTitle}
            aria-label={IPHONE_COPY.accountTitle}
          >
            <span className="tb-account-mark" aria-hidden="true">
              {props.accountInitials || '?'}
            </span>
          </button>
        ) : (
          (mode !== 'translate') && (
          <TitleIcons
            mode={mode}
            source={source}
            opacity={opacity}
            pinned={pinned}
            systemMuted={systemMuted}
            micMuted={micMuted}
            stealth={stealth}
            onSource={props.onSource}
            onOpacity={props.onOpacity}
            onPinned={props.onPinned}
            onSystemMuted={props.onSystemMuted}
            onMicMuted={props.onMicMuted}
            onStealth={props.onStealth}
            onFullScreen={props.onFullScreen}
            onOpenHistory={props.onOpenHistory}
            onMore={props.onMore}
          />
          )
        )}

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
