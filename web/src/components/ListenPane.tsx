import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { CatchNote, Lang, MeetingLine, PairLang } from '../types'
import { TRANSLATE_LANGS } from '../types'
import {
  LISTEN_SCENES,
  MEETING_SPEAKER_OPTIONS,
  bilingualDisabled,
  notesBodyText,
  parseBiLines,
  parseNotes,
  resolveSpeakerName,
  sceneChipLabel,
  sceneLabel,
  visibleSections,
  type ListenScene,
  type MeetingSpeakerId,
  type NotesSectionId,
} from '../listen'
import { IPHONE_COPY, listenChipParts, nativeListenChipOrder, notesChipParts, notesPageTitle, showLineTranslation } from '../iphoneCopy'
import { usePhoneChrome } from '../phoneChrome'
import { iphoneSummaryHeading, liveHeardLines, liveNotesLine, liveStageMode, summaryPlainText } from '../liveView'

interface Props {
  scene: ListenScene
  translateOn: boolean
  translateTo: PairLang
  notesLang: Lang
  lines: MeetingLine[]
  speakerNames: Record<string, string>
  partialSpeaker?: string
  onRenameSpeaker: (id: string, name: string) => void
  partial: string
  listening: boolean
  ended: boolean
  catchNotes: CatchNote[]
  notesRaw: string
  busy: boolean
  summarizing?: boolean
  notesDefaultOpen?: boolean
  notesReveal?: number
  qa?: boolean
  qaSlot?: ReactNode
  onScene: (scene: ListenScene) => void
  speechLang: Lang
  heardLang?: PairLang | null
  onSpeechLang: (lang: Lang) => void
  onTranslate: (on: boolean) => void
  onTranslateTo: (lang: Lang) => void
  meetingSpeakersId: MeetingSpeakerId
  onMeetingSpeakers: (id: MeetingSpeakerId) => void
  onSummary: () => void
  onAsk: (text: string, files?: import('../attach').AttachPayload[]) => void
  elapsedMs?: number
  onExportPdf?: () => void
  actions?: ReactNode
}

const NOTES_W_MIN = 28
const NOTES_W_MAX = 72
const NOTES_W_DEFAULT: Record<ListenScene, number> = {
  meeting: 42,
  lecture: 54,
  interview: 42,
}

function notesWKey(scene: ListenScene) {
  return `nod-notes-w-${scene}`
}

function readNotesW(scene: ListenScene) {
  try {
    const n = Number(localStorage.getItem(notesWKey(scene)))
    if (Number.isFinite(n) && n >= NOTES_W_MIN && n <= NOTES_W_MAX) return n
  } catch {
    /* ignore */
  }
  return NOTES_W_DEFAULT[scene]
}

function writeNotesW(scene: ListenScene, n: number) {
  try {
    localStorage.setItem(notesWKey(scene), String(Math.round(n * 10) / 10))
  } catch {
    /* ignore */
  }
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.2 3.4 5 6.4 7.8 3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ChipPeople() {
  return (
    <svg className="iphone-chip-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6" cy="5.3" r="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M2.5 12.3c.3-2.15 1.55-3.15 3.5-3.15s3.2 1 3.5 3.15" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="11.3" cy="5.7" r="1.65" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10.2 12.3c.25-1.55 1.05-2.45 2.4-2.45 1.25 0 2.15.8 2.4 2.45" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function ChipGlobe() {
  return (
    <svg className="iphone-chip-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.35" />
      <ellipse cx="8" cy="8" rx="2.5" ry="5.8" stroke="currentColor" strokeWidth="1.35" />
      <path d="M2.4 8h11.2M3.4 5.1h9.2M3.4 10.9h9.2" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

function ChipNotes() {
  return (
    <svg className="iphone-chip-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.3" y="2.3" width="9.4" height="11.4" rx="1.5" stroke="currentColor" strokeWidth="1.35" />
      <path d="M5.5 6h5M5.5 8.3h5M5.5 10.6h3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

function SceneMark({ scene, size = 22 }: { scene: ListenScene; size?: number }) {
  const common = {
    className: 'listen-scene-mark',
    width: size,
    height: size,
    viewBox: '0 0 22 22',
    fill: 'none',
    'aria-hidden': true as const,
  }
  if (scene === 'lecture') {
    return (
      <svg {...common}>
        <path d="M3.6 8.6 11 5.4 18.4 8.6 11 11.8 3.6 8.6z" stroke="#22d3ee" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M6.2 10.2v4.2c1.6 1.1 3.4 1.6 4.8 1.6s3.2-.5 4.8-1.6v-4.2" stroke="#7f92b2" strokeWidth="1.35" strokeLinecap="round" />
        <path d="M18.4 8.6v6.4" stroke="#67e8f9" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    )
  }
  if (scene === 'interview') {
    return (
      <svg {...common}>
        <circle cx="7.2" cy="7" r="2.15" stroke="#22d3ee" strokeWidth="1.4" />
        <path d="M3.8 15.6c.3-2.4 1.7-3.6 3.4-3.6s3.1 1.2 3.4 3.6" stroke="#22d3ee" strokeWidth="1.35" strokeLinecap="round" />
        <rect x="13.1" y="5.4" width="4.4" height="7.2" rx="2.2" stroke="#67e8f9" strokeWidth="1.4" />
        <path d="M12.4 10.2h-.6a2.6 2.6 0 0 0 0 4.2h.6M15.3 14.8v1.6M13.6 17h3.4" stroke="#7f92b2" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="7.4" cy="7.2" r="2.05" stroke="#22d3ee" strokeWidth="1.4" />
      <circle cx="14.6" cy="7.2" r="2.05" stroke="#67e8f9" strokeWidth="1.4" />
      <path d="M4.2 15.8c.35-2.35 1.7-3.5 3.2-3.5s2.85 1.15 3.2 3.5" stroke="#22d3ee" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11.4 15.8c.35-2.35 1.7-3.5 3.2-3.5s2.85 1.15 3.2 3.5" stroke="#67e8f9" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3.4 17.6h15.2" stroke="#7f92b2" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function TranslateIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M1 18.8 6.6 3.4 12.2 18.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.9 13.2h7.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <text
        x="10.6"
        y="19.2"
        fill="currentColor"
        fontSize="14.5"
        fontWeight="700"
        fontFamily="Microsoft YaHei UI, Microsoft YaHei, PingFang SC, Noto Sans SC, sans-serif"
      >
        文
      </text>
    </svg>
  )
}

const NOTES_LANGS: Array<{ id: Lang; tag: string; name: string }> = [
  { id: 'auto', tag: 'Auto', name: 'Follow speech' },
  ...TRANSLATE_LANGS,
]

function useDismiss(open: boolean, onClose: () => void) {
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, onClose])
  return boxRef
}

function LangSelect({
  value,
  onChange,
}: {
  value: Lang
  onChange: (lang: Lang) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useDismiss(open, () => setOpen(false))
  const current = NOTES_LANGS.find((l) => l.id === value)
  const phone = usePhoneChrome()

  return (
    <div className={`listen-lang-box${open ? ' open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className={`listen-lang-pair-btn${open ? ' on' : ''}`}
        title={
          value === 'auto'
            ? 'Notes follow the language you speak.'
            : current
              ? `Notes language · ${current.name}`
              : 'Choose notes language'
        }
        aria-label="Notes language"
        aria-haspopup="listbox"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
      >
        {phone ? <ChipNotes /> : null}
        {phone ? (
          <span className="iphone-chip-copy">
            <b>{notesChipParts(value).title}</b>
          </span>
        ) : (
          <span className="listen-lang-tag">{current?.tag ?? 'EN'}</span>
        )}
        {phone ? null : <Chevron />}
      </button>
      {open && (
        <div className="listen-lang-menu" role="listbox">
          {NOTES_LANGS.map((lang) => (
            <button
              key={lang.id}
              type="button"
              role="option"
              aria-selected={lang.id === value}
              className={lang.id === value ? 'on' : ''}
              onClick={() => {
                onChange(lang.id)
                setOpen(false)
              }}
            >
              <b>{lang.tag}</b>
              <span>{lang.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const SPEECH_LANGS: Array<{ id: Lang; tag: string; name: string }> = [
  { id: 'auto', tag: 'Auto', name: 'Detect automatically' },
  ...TRANSLATE_LANGS,
]

function SpeechLangSelect({
  value,
  heard,
  onChange,
  enhanceOn,
  onEnhance,
}: {
  value: Lang
  heard?: PairLang | null
  onChange: (lang: Lang) => void
  enhanceOn?: boolean
  onEnhance?: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useDismiss(open, () => setOpen(false))
  const current = SPEECH_LANGS.find((l) => l.id === value) ?? SPEECH_LANGS[0]
  const heardTag = heard ? TRANSLATE_LANGS.find((l) => l.id === heard)?.tag : ''
  const label = value === 'auto' && heardTag ? `Auto · ${heardTag}` : current.tag
  const phone = usePhoneChrome()

  return (
    <div className={`listen-speech${open ? ' open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className={`listen-lang-pair-btn${open ? ' on' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Speech recognition language"
        title={
          value === 'auto'
            ? heardTag
              ? `Speech recognition · Auto (hearing ${heardTag})`
              : 'Speech recognition · Auto'
            : `Speech recognition · ${current.name}`
        }
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
      >
        {phone ? <ChipGlobe /> : null}
        {phone ? (
          <span className="iphone-chip-copy">
            <b>{listenChipParts(value).title}</b>
          </span>
        ) : (
          <span className="listen-lang-tag">{label}</span>
        )}
        {phone ? null : <Chevron />}
      </button>
      {open && (
        <div className="listen-lang-menu" role="listbox" aria-label="Speech recognition language">
          {SPEECH_LANGS.map((lang) => (
            <button
              key={lang.id}
              type="button"
              role="option"
              aria-selected={value === lang.id}
              className={lang.id === value ? 'on' : ''}
              onClick={() => {
                onChange(lang.id)
                setOpen(false)
              }}
            >
              <b>{lang.tag}</b>
              <span>{lang.name}</span>
            </button>
          ))}
          {onEnhance && (
            <button
              type="button"
              role="option"
              aria-selected={Boolean(enhanceOn)}
              className={enhanceOn ? 'on' : ''}
              onClick={() => {
                onEnhance(!enhanceOn)
                setOpen(false)
              }}
            >
              <b>{enhanceOn ? 'On' : 'Off'}</b>
              <span>{IPHONE_COPY.enhance}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function SceneSelect({
  scene,
  onScene,
  speakersId,
  onSpeakers,
}: {
  scene: ListenScene
  onScene: (scene: ListenScene) => void
  speakersId: MeetingSpeakerId
  onSpeakers: (id: MeetingSpeakerId) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useDismiss(open, () => setOpen(false))
  const phone = usePhoneChrome()

  return (
    <div className={`listen-scene${open ? ' open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className="listen-scene-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
      >
        {phone ? <ChipPeople /> : null}
        {sceneChipLabel(scene, speakersId)}
        {phone ? null : <Chevron />}
      </button>
      {open && (
        <div className="listen-scene-menu">
          <div role="listbox">
            {LISTEN_SCENES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={scene === item.id}
                className={scene === item.id ? 'on' : ''}
                onClick={() => {
                  onScene(item.id)
                  setOpen(false)
                }}
              >
                <SceneMark scene={item.id} size={20} />
                <b>{item.label}</b>
                <span>
                  {item.id === 'meeting'
                    ? 'Decisions and action items'
                    : item.id === 'lecture'
                      ? 'Revision notes and homework'
                      : 'Hear a question, draft an answer'}
                </span>
              </button>
            ))}
          </div>
          {scene === 'meeting' && (
            <div className="listen-scene-people" role="group" aria-label="Number of speakers">
              {MEETING_SPEAKER_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={o.id === speakersId}
                  className={o.id === speakersId ? 'on' : ''}
                  onClick={() => onSpeakers(o.id)}
                >
                  {o.chip}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BiText({ text, bilingual }: { text: string; bilingual: boolean }) {
  if (!text) return null
  if (!bilingual) return <p>{notesBodyText(text)}</p>
  const blocks = parseBiLines(text)
  return (
    <div className="listen-bi">
      {blocks.map((block, i) => (
        <div className="listen-bi-row" key={`${block.src}-${i}`}>
          <p>{block.src}</p>
          {block.tr ? <p className="listen-note-tr">{block.tr}</p> : null}
        </div>
      ))}
    </div>
  )
}

function LectureStudy({
  sections,
  bilingual,
}: {
  sections: Array<{ id: NotesSectionId; title: string; items: string[] }>
  bilingual: boolean
}) {
  return (
    <div className="lec-sheet">
      {sections.map((section) => {
        if (section.id === 'summary') {
          return (
            <div className="lec-overview" key={section.id}>
              <h3>{section.title}</h3>
              <BiText text={section.items[0]} bilingual={bilingual} />
            </div>
          )
        }
        if (section.id === 'keyPoints') {
          return (
            <div className="lec-block" key={section.id}>
              <h3>{section.title}</h3>
              <ol className="lec-concepts">
                {section.items.map((item, i) => (
                  <li key={`${i}-${item}`}>
                    <b>{i + 1}</b>
                    <span><BiText text={item} bilingual={bilingual} /></span>
                  </li>
                ))}
              </ol>
            </div>
          )
        }
        if (section.id === 'revisionNotes') {
          return (
            <div className="lec-block" key={section.id}>
              <h3>{section.title}</h3>
              <div className="lec-revise">
                {section.items.map((item, i) => (
                  <div className="lec-flash" key={`${i}-${item}`}>
                    <BiText text={item} bilingual={bilingual} />
                  </div>
                ))}
              </div>
            </div>
          )
        }
        if (section.id === 'followUps') {
          return (
            <div className="lec-hw" key={section.id}>
              <h3>{section.title}</h3>
              <ul>
                {section.items.map((item, i) => (
                  <li key={`${i}-${item}`}><BiText text={item} bilingual={bilingual} /></li>
                ))}
              </ul>
            </div>
          )
        }
        return (
          <div className="lec-block" key={section.id}>
            <h3>{section.title}</h3>
            <ul>
              {section.items.map((item, i) => (
                <li key={`${i}-${item}`}><BiText text={item} bilingual={bilingual} /></li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function MeetingNotes({
  sections,
  bilingual,
}: {
  sections: Array<{ id: NotesSectionId; title: string; items: string[] }>
  bilingual: boolean
}) {
  return (
    <>
      {sections.map((section) => (
        <div className="listen-block" key={section.id}>
          <h3>{section.title}</h3>
          {section.id === 'summary' ? (
            <BiText text={section.items[0]} bilingual={bilingual} />
          ) : (
            <ul>
              {section.items.map((item, i) => (
                <li key={`${i}-${item}`}><BiText text={item} bilingual={bilingual} /></li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  )
}

function IphoneLiveContent({
  listening,
  headline,
  previous,
  notes,
}: {
  listening: boolean
  headline: string
  previous: string
  notes: string
}) {
  return (
    <div className={`iphone-live${listening ? ' live' : ''}`}>
      <div className="iphone-live-wave" aria-hidden="true">
        {Array.from({ length: 22 }, (_, i) => <i key={i} />)}
      </div>
      <div className="iphone-live-now">
        <span className="iphone-live-dot" />
        {listening ? IPHONE_COPY.listeningNowLabel : IPHONE_COPY.pausedStatus}
      </div>
      <div className="iphone-live-caption">
        {headline ? <p className="iphone-live-headline">{headline}</p> : null}
        {notes ? <p className="iphone-live-notes">{notes}</p> : null}
        {previous ? <p className="iphone-live-prev">{previous}</p> : null}
      </div>
    </div>
  )
}

async function copyText(text: string) {
  const value = text.trim()
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    /* ignore */
  }
}

function IphoneLineActions({ text }: { text: string }) {
  return (
    <div className="iphone-line-actions">
      <button type="button" onClick={() => void copyText(text)}>{IPHONE_COPY.copyLine}</button>
    </div>
  )
}

function IphoneSummary({
  scene,
  sections,
  bilingual,
}: {
  scene: ListenScene
  sections: Array<{ id: NotesSectionId; title: string; items: string[] }>
  bilingual: boolean
}) {
  return (
    <>
      {sections.map((section) => (
        <div className={`iphone-sum-block ${section.id}`} key={section.id}>
          <h3>{iphoneSummaryHeading(scene, section.id)}</h3>
          {section.id === 'summary' ? (
            <BiText text={section.items[0]} bilingual={bilingual} />
          ) : (
            <ul>
              {section.items.map((item, i) => (
                <li key={`${i}-${item}`}>
                  <span className="iphone-sum-mark" aria-hidden="true">
                    {section.id === 'decisions' ? '✓' : section.id === 'actionItems' ? '☐' : '•'}
                  </span>
                  <BiText text={item} bilingual={bilingual} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  )
}

function useStackedLayout() {
  const [stacked, setStacked] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 980px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 980px)')
    const sync = () => setStacked(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return stacked
}

function SpeakerName({
  speakerId,
  label,
  onRename,
}: {
  speakerId: string
  label: string
  onRename: (id: string, name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  useEffect(() => {
    if (!editing) setDraft(label)
  }, [editing, label])
  const commit = () => {
    const next = draft.trim()
    if (next && next !== label) onRename(speakerId, next)
    setEditing(false)
  }
  if (editing) {
    return (
      <input
        className="listen-spk-input"
        value={draft}
        autoFocus
        maxLength={24}
        aria-label="Rename speaker"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="listen-spk"
      title="Click to name this voice"
      onClick={() => setEditing(true)}
    >
      {label}
    </button>
  )
}

interface LineRowProps {
  ts: string
  text: string
  translation: string
  speaker: string
  speakerLabel: string
  live: boolean
  last: boolean
  translateOn: boolean
  translateFailed: boolean
  busy: boolean
  onRename: (id: string, name: string) => void
  onOpen?: () => void
  actions?: boolean
}

// A two-hour session renders thousands of these. Without memo every partial
// transcript update rebuilt the whole list.
const LineRow = memo(function LineRow(p: LineRowProps) {
  const showTr = showLineTranslation({
    translateOn: p.translateOn,
    original: p.text,
    translation: p.translation,
    last: p.last,
    native: p.actions,
    pending: p.busy,
  })
  // A line whose translation gave up shows a failed badge instead of a blank /
  // ellipsis row. (showLineTranslation returns false for an empty translation,
  // so this is separate from showTr; switching the target re-arms it.)
  const showFailed = p.translateFailed && p.translateOn
  return (
    <div className={`listen-line${p.live ? ' live' : ''}${p.actions ? ' iphone-tr-line' : ''}`} onClick={p.onOpen}>
      <div className="listen-ts">
        {p.ts}
        {p.speaker ? <SpeakerName speakerId={p.speaker} label={p.speakerLabel} onRename={p.onRename} /> : null}
      </div>
      <div>
        <div className="listen-orig">{p.text}</div>
        {showTr && (
          <div className="listen-tr">{p.translation || (p.busy ? '…' : '')}</div>
        )}
        {showFailed && <div className="listen-tr failed">Translation failed</div>}
        {p.actions ? <IphoneLineActions text={p.text} /> : null}
      </div>
    </div>
  )
})

export default function ListenPane(props: Props) {
  const phone = usePhoneChrome()
  const [input, setInput] = useState('')
  const [notesOpen, setNotesOpen] = useState(Boolean(props.notesDefaultOpen))
  const [mobilePane, setMobilePane] = useState<'live' | 'transcript' | 'notes'>(props.notesDefaultOpen ? 'notes' : 'live')
  const [notesW, setNotesW] = useState(() => readNotesW(props.scene))
  const [dragging, setDragging] = useState(false)
  const [openedLine, setOpenedLine] = useState('')
  const stacked = useStackedLayout()
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const notesWRef = useRef(notesW)
  notesWRef.current = notesW
  // notesRaw grows with every streamed chunk; re-parsing it on each render made
  // the cost quadratic over a summary.
  const notes = useMemo(() => parseNotes(props.notesRaw), [props.notesRaw])
  const sections = useMemo(() => visibleSections(props.scene, notes), [props.scene, notes])
  const lecture = props.scene === 'lecture'
  const notesHeading = notesPageTitle(props.scene)

  useEffect(() => {
    setNotesW(readNotesW(props.scene))
  }, [props.scene])

  useEffect(() => {
    if (!props.notesDefaultOpen) return
    setNotesOpen(true)
    setMobilePane('notes')
  }, [props.notesDefaultOpen, props.notesReveal])

  useEffect(() => {
    const el = leftRef.current
    if (!el) return
    // Reading scrollHeight forces layout, so coalesce bursts of partials into
    // one measurement per frame and leave the user alone if they scrolled up.
    const frame = requestAnimationFrame(() => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240
      if (nearBottom) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [props.lines.length, props.partial])

  useEffect(() => {
    rightRef.current?.scrollTo({ top: rightRef.current.scrollHeight })
  }, [props.catchNotes, props.notesRaw])

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const box = splitRef.current?.getBoundingClientRect()
    if (!box?.width) return
    const next = Math.min(NOTES_W_MAX, Math.max(NOTES_W_MIN, ((box.right - e.clientX) / box.width) * 100))
    setNotesW(next)
  }

  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    writeNotesW(props.scene, notesWRef.current)
  }

  const openNotes = () => {
    setNotesOpen(true)
    setMobilePane('notes')
  }

  const runSummary = () => {
    if (props.busy || props.lines.length === 0) return
    openNotes()
    props.onSummary()
  }

  const submit = () => {
    const text = input.trim()
    if (!text || props.busy) return
    if (!phone) openNotes()
    props.onAsk(text)
    setInput('')
  }
  const lastHeard = (props.partial || props.lines[props.lines.length - 1]?.text || '').trim()
  const liveMode = liveStageMode({
    listening: props.listening,
    elapsedMs: props.elapsedMs || 0,
    hasHeardText: Boolean(lastHeard),
  })
  const heard = liveHeardLines({ lines: props.lines, partial: props.partial })
  const notesLine = liveNotesLine({
    lines: props.lines,
    partial: props.partial,
    translateOn: props.translateOn,
  })
  const showStage = phone && mobilePane === 'live'
  const stackedPane = showStage ? 'stage' : !notesOpen || mobilePane === 'transcript' || mobilePane === 'live' ? 'live' : 'notes'

  const controls = (
      <div className="listen-controls">
        {!props.qa && !phone && (
          <button
            type="button"
            className={`listen-icon-btn listen-side-left listen-bi-btn${props.translateOn ? ' on' : ''}`}
            role="switch"
            aria-checked={props.translateOn}
            disabled={bilingualDisabled(props.notesLang, props.translateOn, props.translateTo)}
            title={
              bilingualDisabled(props.notesLang, props.translateOn, props.translateTo)
                ? 'Bilingual needs a notes language — pick one first'
                : props.translateOn
                  ? 'Bilingual on — tap to turn off'
                  : 'Bilingual off — tap to show translations'
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onTranslate(!props.translateOn)}
          >
            <TranslateIcon />
          </button>
        )}
        {phone ? (
          <>
            {nativeListenChipOrder(props.scene).map((chip) => {
              if (chip === 'scene') {
                return <SceneSelect key="scene" scene={props.scene} onScene={props.onScene} speakersId={props.meetingSpeakersId} onSpeakers={props.onMeetingSpeakers} />
              }
              if (chip === 'speech') {
                return (
                  <SpeechLangSelect
                    key="speech"
                    value={props.speechLang}
                    heard={props.heardLang}
                    onChange={props.onSpeechLang}
                    enhanceOn={props.qa ? undefined : props.translateOn}
                    onEnhance={props.qa ? undefined : props.onTranslate}
                  />
                )
              }
              if (chip === 'notes' && !props.qa) {
                return <LangSelect key="notes" value={props.notesLang} onChange={props.onTranslateTo} />
              }
              return null
            })}
          </>
        ) : !props.qa ? (
          <>
            <SceneSelect scene={props.scene} onScene={props.onScene} speakersId={props.meetingSpeakersId} onSpeakers={props.onMeetingSpeakers} />
            <div className="listen-lang-pair" title="Speech to notes language">
              <SpeechLangSelect
                value={props.speechLang}
                heard={props.heardLang}
                onChange={props.onSpeechLang}
              />
              <span className="listen-lang-dash" aria-hidden="true">-</span>
              <LangSelect value={props.notesLang} onChange={props.onTranslateTo} />
            </div>
          </>
        ) : (
          <>
            <SceneSelect scene={props.scene} onScene={props.onScene} speakersId={props.meetingSpeakersId} onSpeakers={props.onMeetingSpeakers} />
            <div className="listen-lang-pair listen-lang-single" title="Speech recognition language">
              <SpeechLangSelect
                value={props.speechLang}
                heard={props.heardLang}
                onChange={props.onSpeechLang}
              />
            </div>
          </>
        )}
      </div>
  )

  const tabs = !props.qa ? (
        <div className="listen-mobile-tabs" role="tablist" aria-label={phone ? 'Live, transcript, or notes' : 'Live or notes'}>
          <button
            type="button"
            role="tab"
            aria-selected={phone ? mobilePane === 'live' : stackedPane === 'live'}
            className={(phone ? mobilePane === 'live' : stackedPane === 'live') ? 'on' : ''}
            onClick={() => setMobilePane('live')}
          >
            {phone ? IPHONE_COPY.liveTab : 'Live'}
          </button>
          {phone ? (
            <button
              type="button"
              role="tab"
              aria-selected={mobilePane === 'transcript'}
              className={mobilePane === 'transcript' ? 'on' : ''}
              onClick={() => {
                setNotesOpen(false)
                setMobilePane('transcript')
              }}
            >
              {IPHONE_COPY.transcriptTab}
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={phone ? mobilePane === 'notes' : stackedPane === 'notes'}
            className={(phone ? mobilePane === 'notes' : stackedPane === 'notes') ? 'on' : ''}
            onClick={openNotes}
          >
            {phone ? IPHONE_COPY.summaryTab : 'Notes'}
          </button>
        </div>
  ) : null

  return (
    <div className={`listen-main scene-${props.scene}${props.translateOn ? ' tr-on' : ' tr-off'}${props.ended ? ' ended' : ''}${props.qa ? ' qa' : ''}`}>
      {phone ? (
        <div className="iphone-stack">
          {props.actions}
          {controls}
          {tabs}
        </div>
      ) : (
        <>
          {controls}
          {tabs}
        </>
      )}

      {showStage && !props.qa && liveMode === 'content' ? (
        <IphoneLiveContent
          listening={props.listening}
          headline={heard.headline}
          previous={heard.previous}
          notes={notesLine}
        />
      ) : showStage && !props.qa ? (
        <div className={`iphone-stage${props.listening ? ' live' : ''}`}>
          <div className="iphone-viz" aria-hidden="true">
            <span className="iphone-ripple r1" />
            <span className="iphone-ripple r2" />
            <span className="iphone-ripple r3" />
            <span className="iphone-wave-left">
              <i /><i /><i /><i /><i />
            </span>
            <span className="iphone-viz-core">
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                <rect x="14" y="6" width="8" height="14" rx="4" fill="currentColor" />
                <path d="M10 18a8 8 0 0 0 16 0M18 26v4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </span>
            <span className="iphone-wave-right">
              <i /><i /><i /><i /><i />
            </span>
          </div>
          <b>{props.listening ? IPHONE_COPY.listeningNow : IPHONE_COPY.readyTitle}</b>
          {!props.listening ? <p className="iphone-stage-help">{IPHONE_COPY.readyHelp}</p> : null}
          <p className="iphone-ai-note">{IPHONE_COPY.aiNote}</p>
        </div>
      ) : null}

      {props.qa ? (
        <div className="listen-qa">
          {props.qaSlot}
        </div>
      ) : (
        <>
          {!showStage && (
          <div
            ref={splitRef}
            className={`listen-split${notesOpen ? ' notes-on' : ''}${dragging ? ' dragging' : ''}${stacked ? ` stacked show-${stackedPane}` : ''}`}
            style={notesOpen ? { ['--notes-w' as string]: `${notesW}%` } : undefined}
          >
            <section className="listen-pane">
              <div className="listen-kicker">
                {phone ? 'TRANSCRIPT' : lecture ? 'Classroom' : 'Transcript'}
                {props.lines.length > 0 && !notesOpen && (
                  <button
                    type="button"
                    className="listen-catch"
                    disabled={props.busy}
                    onClick={runSummary}
                  >
                    Summarize
                  </button>
                )}
              </div>
              <div className="listen-scroll" ref={leftRef}>
                {props.lines.length === 0 && !props.partial ? (
                  <div className={`listen-empty${phone ? ' iphone-tr-empty' : ''}`}>
                    {phone
                      ? IPHONE_COPY.emptyLive
                      : lecture
                        ? 'Start listening. This side is the lecture stream. Notes stay closed until you ask or tap Summarize.'
                        : 'Start listening. The left side keeps what was said. Notes stay closed until you ask or tap Summarize.'}
                  </div>
                ) : (
                  props.lines.map((line, i) => (
                    <LineRow
                      key={line.id || `${line.ts}-${i}`}
                      ts={line.ts}
                      text={line.text}
                      translation={line.translation || ''}
                      speaker={line.speaker || ''}
                      speakerLabel={line.speaker ? resolveSpeakerName(props.speakerNames, line.speaker) : ''}
                      live={props.listening && i === props.lines.length - 1 && !props.partial}
                      last={(i === props.lines.length - 1 && !props.partial) || openedLine === line.id}
                      translateOn={props.translateOn}
                      translateFailed={line.translateFailed || false}
                      onOpen={() => setOpenedLine(line.id)}
                      busy={props.busy}
                      onRename={props.onRenameSpeaker}
                      actions={phone}
                    />
                  ))
                )}
                {props.partial && (
                  <div className="listen-line live">
                    <div className="listen-ts">
                      live
                      {props.partialSpeaker ? (
                        <span className="listen-spk">
                          {resolveSpeakerName(props.speakerNames, props.partialSpeaker) || props.partialSpeaker}
                        </span>
                      ) : null}
                    </div>
                    <div className="listen-orig">{props.partial}</div>
                  </div>
                )}
              </div>
            </section>

            <div
              className="listen-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize notes"
              aria-valuemin={NOTES_W_MIN}
              aria-valuemax={NOTES_W_MAX}
              aria-valuenow={Math.round(notesW)}
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              onDoubleClick={() => {
                const next = NOTES_W_DEFAULT[props.scene]
                setNotesW(next)
                writeNotesW(props.scene, next)
              }}
            />

            <section className="listen-pane listen-notes">
              <div className="listen-note-head">
                <div className="listen-kicker" style={{ padding: 0 }}>
                  {lecture ? 'Study notes' : `Notes · ${sceneLabel(props.scene)}`}
                </div>
                {props.lines.length > 0 && (
                  <button
                    type="button"
                    className="listen-catch"
                    disabled={props.busy}
                    onClick={runSummary}
                  >
                    Summarize
                  </button>
                )}
                {props.ended && <span className="listen-hint">{lecture ? 'Class ended' : 'Session ended'}</span>}
                <button
                  type="button"
                  className="listen-notes-close"
                  title="Hide notes"
                  onClick={() => {
                    setNotesOpen(false)
                    setMobilePane('live')
                  }}
                >
                  ×
                </button>
              </div>
              <div className="listen-scroll" ref={rightRef}>
                {props.catchNotes.length === 0 && !sections.length && !props.busy && (
                  <div className="listen-empty">
                    {phone
                      ? IPHONE_COPY.emptyNotes
                      : <>Ask in the box below — the answer lands here. Or tap <b>Summarize</b> for a recap.</>}
                  </div>
                )}
                {props.catchNotes.map((note, i) => (
                  <div className={`listen-card${note.kind === 'ask' ? ' ask' : ''}`} key={note.id || `${note.title}-${i}`}>
                    <div className="listen-tag">{note.kind === 'ask' ? 'Ask' : note.title}</div>
                    {note.question ? <p className="listen-q">{note.question}</p> : null}
                    <BiText
                      text={note.text || (props.busy && !note.text ? '…' : note.kind === 'ask' && !note.text ? 'Waiting for an answer…' : '')}
                      bilingual={false}
                    />
                  </div>
                ))}
                {props.summarizing && props.busy && !sections.length && (
                  <div className="listen-empty">{lecture ? 'Writing the study sheet…' : 'Writing the summary…'}</div>
                )}
                {phone && notesHeading && sections.length > 0 ? (
                  <h2 className="iphone-notes-title">{notesHeading}</h2>
                ) : null}
                {lecture && sections.length > 0 && (
                  <LectureStudy sections={sections} bilingual={false} />
                )}
                {!lecture && sections.length > 0 && (
                  phone ? (
                    <IphoneSummary
                      scene={props.scene}
                      sections={sections}
                      bilingual={false}
                    />
                  ) : (
                    <MeetingNotes sections={sections} bilingual={false} />
                  )
                )}
                {phone && (sections.length > 0 || props.catchNotes.some((note) => note.text.trim())) ? (
                  <div className="iphone-summary-actions">
                    <button type="button" onClick={() => props.onExportPdf?.()}>{IPHONE_COPY.histPdf}</button>
                    <button
                      type="button"
                      onClick={() => void copyText(summaryPlainText({ scene: props.scene, notes, catchNotes: props.catchNotes }))}
                    >
                      {IPHONE_COPY.copyLine}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const text = summaryPlainText({ scene: props.scene, notes, catchNotes: props.catchNotes })
                        if (navigator.share) void navigator.share({ text }).catch(() => copyText(text))
                        else void copyText(text)
                      }}
                    >
                      {IPHONE_COPY.shareSummary}
                    </button>
                  </div>
                ) : phone && props.lines.length > 0 ? (
                  <button type="button" className="iphone-summarize" disabled={props.busy} onClick={runSummary}>
                    {IPHONE_COPY.summarizeNow}
                  </button>
                ) : null}
              </div>
            </section>
          </div>
          )}

          <div className="listen-prompt">
            {phone ? (
              <span className="iphone-ask-spark" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1.2l.85 4.1L13 6.2 8.85 7.3 8 11.4 7.15 7.3 3 6.2l4.15-.9L8 1.2z" />
                </svg>
              </span>
            ) : null}
            <input
              value={input}
              placeholder={phone ? (props.listening ? IPHONE_COPY.askLive : IPHONE_COPY.askReady) : 'Ask anything — the answer shows in Notes'}
              onChange={(e) => {
                setInput(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
            <button type="button" className="listen-go" disabled={props.busy || !input.trim()} onClick={submit}>
              {phone ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M9 13.4V4.8M5.4 8.2 9 4.6l3.6 3.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                'Ask'
              )}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
