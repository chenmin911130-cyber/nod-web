import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { CatchNote, Lang, MeetingLine, PairLang } from '../types'
import { TRANSLATE_LANGS } from '../types'
import {
  LISTEN_SCENES,
  parseBiLines,
  parseNotes,
  resolveSpeakerName,
  sceneLabel,
  visibleSections,
  type ListenScene,
  type NotesSectionId,
} from '../listen'

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
  elapsedLabel: string
  listening: boolean
  ended: boolean
  catchNotes: CatchNote[]
  notesRaw: string
  busy: boolean
  summarizing?: boolean
  qa?: boolean
  qaSlot?: ReactNode
  onScene: (scene: ListenScene) => void
  onTranslate: (on: boolean) => void
  onTranslateTo: (lang: Lang) => void
  onSummary: () => void
  onAsk: (text: string) => void
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

function NotesIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="3.6" y="3.2" width="14.8" height="15.6" rx="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.8 8.2h8.4M6.8 11.6h6.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

const NOTES_LANGS: Array<{ id: Lang; tag: string; name: string }> = [
  { id: 'auto', tag: 'AU', name: 'Auto · all languages' },
  ...TRANSLATE_LANGS,
]

function LangSelect({
  value,
  onChange,
}: {
  value: Lang
  onChange: (lang: Lang) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const current = NOTES_LANGS.find((l) => l.id === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className={`listen-lang-box${open ? ' open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className={`listen-icon-btn${open ? ' on' : ''}`}
        title={
          value === 'auto'
            ? 'Auto. Notes follow the language you speak.'
            : current
              ? `Notes language · ${current.name}`
              : 'Choose notes language'
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="listen-lang-tag">{current?.tag ?? 'AU'}</span>
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

function SceneSelect({ scene, onScene }: { scene: ListenScene; onScene: (scene: ListenScene) => void }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className={`listen-scene${open ? ' open' : ''}`} ref={boxRef}>
      <span className="listen-scene-kicker" title={sceneLabel(scene)}>
        <SceneMark scene={scene} />
      </span>
      <button
        type="button"
        className="listen-scene-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {sceneLabel(scene)}
        <Chevron />
      </button>
      {open && (
        <div className="listen-scene-menu" role="listbox">
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
                    : 'Live Q&A, same as before'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function BiText({ text, bilingual }: { text: string; bilingual: boolean }) {
  if (!text) return null
  if (!bilingual) return <p>{text}</p>
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
  const byId = (id: NotesSectionId) => sections.find((row) => row.id === id)
  const overview = byId('summary')
  const concepts = byId('keyPoints')
  const details = byId('importantDetails')
  const revise = byId('revisionNotes')
  const homework = byId('followUps')

  return (
    <div className="lec-sheet">
      {overview && (
        <div className="lec-overview">
          <h3>{overview.title}</h3>
          <BiText text={overview.items[0]} bilingual={bilingual} />
        </div>
      )}
      {concepts && (
        <div className="lec-block">
          <h3>{concepts.title}</h3>
          <ol className="lec-concepts">
            {concepts.items.map((item, i) => (
              <li key={`${i}-${item}`}>
                <b>{i + 1}</b>
                <span><BiText text={item} bilingual={bilingual} /></span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {revise && (
        <div className="lec-block">
          <h3>{revise.title}</h3>
          <div className="lec-revise">
            {revise.items.map((item, i) => (
              <div className="lec-flash" key={`${i}-${item}`}>
                <BiText text={item} bilingual={bilingual} />
              </div>
            ))}
          </div>
        </div>
      )}
      {details && (
        <div className="lec-block">
          <h3>{details.title}</h3>
          <ul>
            {details.items.map((item, i) => (
              <li key={`${i}-${item}`}><BiText text={item} bilingual={bilingual} /></li>
            ))}
          </ul>
        </div>
      )}
      {homework && (
        <div className="lec-hw">
          <h3>{homework.title}</h3>
          <ul>
            {homework.items.map((item, i) => (
              <li key={`${i}-${item}`}><BiText text={item} bilingual={bilingual} /></li>
            ))}
          </ul>
        </div>
      )}
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
  translateOn: boolean
  busy: boolean
  onRename: (id: string, name: string) => void
}

// A two-hour session renders thousands of these. Without memo every partial
// transcript update rebuilt the whole list.
const LineRow = memo(function LineRow(p: LineRowProps) {
  return (
    <div className={`listen-line${p.live ? ' live' : ''}`}>
      <div className="listen-ts">
        {p.ts}
        {p.speaker ? <SpeakerName speakerId={p.speaker} label={p.speakerLabel} onRename={p.onRename} /> : null}
      </div>
      <div>
        <div className="listen-orig">{p.text}</div>
        {p.translateOn && <div className="listen-tr">{p.translation || (p.busy ? '…' : '')}</div>}
      </div>
    </div>
  )
})

export default function ListenPane(props: Props) {
  const [input, setInput] = useState('')
  const [notesOpen, setNotesOpen] = useState(false)
  const [mobilePane, setMobilePane] = useState<'live' | 'notes'>('live')
  const [notesW, setNotesW] = useState(() => readNotesW(props.scene))
  const [dragging, setDragging] = useState(false)
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

  useEffect(() => {
    setNotesW(readNotesW(props.scene))
  }, [props.scene])

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
    openNotes()
    props.onAsk(text)
    setInput('')
  }

  const stackedPane = !notesOpen || mobilePane === 'live' ? 'live' : 'notes'

  return (
    <div className={`listen-main scene-${props.scene}${props.translateOn ? ' tr-on' : ' tr-off'}${props.ended ? ' ended' : ''}${props.qa ? ' qa' : ''}`}>
      <div className="listen-controls">
        {!props.qa && (
          <button
            type="button"
            className={`listen-icon-btn listen-side-left${props.translateOn ? ' on' : ''}`}
            role="switch"
            aria-checked={props.translateOn}
            title={props.translateOn ? 'Translate on' : 'Translate off'}
            onClick={() => props.onTranslate(!props.translateOn)}
          >
            <TranslateIcon />
          </button>
        )}
        <SceneSelect scene={props.scene} onScene={props.onScene} />
        {!props.qa && (
          <div className="listen-tools">
            <LangSelect value={props.notesLang} onChange={props.onTranslateTo} />
            <button
              type="button"
              className={`listen-icon-btn${notesOpen ? ' on' : ''}`}
              title={notesOpen ? 'Hide notes' : 'Show notes'}
              onClick={() => {
                if (stacked) {
                  if (notesOpen && stackedPane === 'notes') {
                    setNotesOpen(false)
                    setMobilePane('live')
                  } else {
                    openNotes()
                  }
                } else {
                  setNotesOpen((v) => !v)
                }
              }}
            >
              <NotesIcon />
            </button>
          </div>
        )}
      </div>

      {!props.qa && (
        <div className="listen-mobile-tabs" role="tablist" aria-label="Live or notes">
          <button
            type="button"
            role="tab"
            aria-selected={stackedPane === 'live'}
            className={stackedPane === 'live' ? 'on' : ''}
            onClick={() => setMobilePane('live')}
          >
            Live
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stackedPane === 'notes'}
            className={stackedPane === 'notes' ? 'on' : ''}
            onClick={openNotes}
          >
            Notes
          </button>
        </div>
      )}

      {props.qa ? (
        <div className="listen-qa">{props.qaSlot}</div>
      ) : (
        <>
          <div
            ref={splitRef}
            className={`listen-split${notesOpen ? ' notes-on' : ''}${dragging ? ' dragging' : ''}${stacked ? ` stacked show-${stackedPane}` : ''}`}
            style={notesOpen ? { ['--notes-w' as string]: `${notesW}%` } : undefined}
          >
            <section className="listen-pane">
              <div className="listen-kicker">
                {lecture ? 'Classroom' : 'Transcript'}
                <span className={`listen-timer${props.listening ? ' live' : ''}`}>
                  {props.elapsedLabel === '00:00:00' && !props.listening ? '' : props.elapsedLabel}
                </span>
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
                  <div className="listen-empty">
                    {lecture
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
                      translateOn={props.translateOn}
                      busy={props.busy}
                      onRename={props.onRenameSpeaker}
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
                    Ask in the box below — the answer lands here. Or tap <b>Summarize</b> for a recap.
                  </div>
                )}
                {props.catchNotes.map((note, i) => (
                  <div className={`listen-card${note.kind === 'ask' ? ' ask' : ''}`} key={note.id || `${note.title}-${i}`}>
                    <div className="listen-tag">{note.kind === 'ask' ? 'Ask' : note.title}</div>
                    {note.question ? <p className="listen-q">{note.question}</p> : null}
                    <BiText
                      text={note.text || (props.busy && i === props.catchNotes.length - 1 ? '…' : '')}
                      bilingual={props.translateOn}
                    />
                  </div>
                ))}
                {props.summarizing && props.busy && !sections.length && (
                  <div className="listen-empty">{lecture ? 'Writing the study sheet…' : 'Writing the summary…'}</div>
                )}
                {lecture && sections.length > 0 && (
                  <LectureStudy sections={sections} bilingual={props.translateOn} />
                )}
                {!lecture && sections.length > 0 && (
                  <MeetingNotes sections={sections} bilingual={props.translateOn} />
                )}
              </div>
            </section>
          </div>

          <div className="listen-prompt">
            <input
              value={input}
              placeholder="Ask anything — the answer shows in Notes"
              onChange={(e) => {
                setInput(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
            <button type="button" className="listen-go" disabled={props.busy || !input.trim()} onClick={submit}>
              Ask
            </button>
          </div>
        </>
      )}
    </div>
  )
}
