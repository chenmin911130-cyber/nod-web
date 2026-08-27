import { useEffect, useRef, useState } from 'react'
import type { Copy } from './copy'

export type DemoMode = 'meeting' | 'translate' | 'interview'

function formatClock(total: number) {
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <path d="M4.2 2.4v9.2L12 7 4.2 2.4z" />
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.4 9.1 6 13.6 7.1 9.1 8.2 8 12.8 6.9 8.2 2.4 7.1 6.9 6 8 1.4z" fill="currentColor" />
    </svg>
  )
}

export function HeroBackdrop() {
  return (
    <div className="hero-back" aria-hidden="true">
      <div className="hero-streaks" />
      <div className="hero-floor" />
      <i className="hero-wisp a" />
      <i className="hero-wisp b" />
      <i className="hero-wisp c" />
    </div>
  )
}

function LiveWave() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let t = 0
    let alive = true

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const pathAt = (w: number, h: number, phase: number, amp: number) => {
      const mid = h * 0.58
      ctx.beginPath()
      ctx.moveTo(0, h)
      for (let x = 0; x <= w; x += 2) {
        const nx = x / w
        const y =
          mid +
          Math.sin(nx * 9.5 + phase) * amp +
          Math.sin(nx * 18 - phase * 1.35) * (amp * 0.32)
        ctx.lineTo(x, y)
      }
      ctx.lineTo(w, h)
      ctx.closePath()
    }

    const tick = () => {
      if (!alive) return
      t += 0.04
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      ;[
        { phase: t * 1.4, amp: h * 0.28, fill: 'rgba(0, 140, 220, 0.28)', stroke: 'rgba(0, 180, 255, 0.45)' },
        { phase: t * 1.7 + 0.8, amp: h * 0.22, fill: 'rgba(0, 210, 255, 0.38)', stroke: 'rgba(90, 230, 255, 0.95)' },
        { phase: t * 2.1 + 1.6, amp: h * 0.16, fill: 'rgba(180, 245, 255, 0.18)', stroke: 'rgba(210, 250, 255, 0.9)' },
      ].forEach((layer) => {
        pathAt(w, h, layer.phase, layer.amp)
        ctx.fillStyle = layer.fill
        ctx.fill()
        ctx.strokeStyle = layer.stroke
        ctx.lineWidth = 2
        ctx.shadowColor = '#00d2ff'
        ctx.shadowBlur = 16
        ctx.stroke()
      })
      ctx.shadowBlur = 0
      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas className="hero-livewave" ref={ref} aria-hidden="true" />
}

export function HeroStage({
  t,
  onOpen,
}: {
  t: Copy
  onOpen: (mode: DemoMode) => void
}) {
  const [secs, setSecs] = useState(167)

  useEffect(() => {
    const clock = window.setInterval(() => setSecs((n) => n + 1), 1000)
    return () => window.clearInterval(clock)
  }, [])

  return (
    <div className="hero-stage">
      <button type="button" className="hero-glass" onClick={() => onOpen('meeting')} aria-label={t.watchDemo}>
        <div className="hero-glass-bar">
          <span className="hero-live">
            <i />
            {t.previewListening}
          </span>
          <span className="hero-clock">{formatClock(secs)}</span>
          <span className="hero-pair">{t.previewPair}</span>
        </div>
        <LiveWave />
        <div className="hero-card-body">
          <div className="hero-block">
            <div className="hero-kicker">{t.previewTranscribe}</div>
            <p>
              <time>10:32:47</time>
              {t.previewMeetLine}
            </p>
          </div>
          <div className="hero-block es">
            <div className="hero-kicker">{t.previewTranslate}</div>
            <p>
              <time>10:32:47</time>
              {t.previewMeetTr}
            </p>
          </div>
        </div>
        <div className="hero-sum">
          <span>
            <SparkleIcon />
            {t.previewSummary}
          </span>
          <em>{t.previewMeetSum}</em>
          <i>{t.previewView} →</i>
        </div>
      </button>
    </div>
  )
}

export function DemoModal({
  t,
  open,
  mode,
  onMode,
  onClose,
}: {
  t: Copy
  open: boolean
  mode: DemoMode
  onMode: (mode: DemoMode) => void
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="demo-overlay" role="dialog" aria-modal="true" aria-label={t.demoTitle}>
      <button type="button" className="demo-backdrop" onClick={onClose} aria-label={t.demoClose} />
      <div className="demo-sheet">
        <header className="demo-head">
          <div>
            <strong>{t.demoTitle}</strong>
            <p>{t.demoHint}</p>
          </div>
          <div className="demo-tabs" role="tablist">
            {(['meeting', 'translate', 'interview'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mode === id}
                className={mode === id ? 'on' : undefined}
                onClick={() => onMode(id)}
              >
                {id === 'meeting' ? t.demoMeeting : id === 'translate' ? t.demoTranslate : t.demoInterview}
              </button>
            ))}
          </div>
          <button type="button" className="demo-x" onClick={onClose} aria-label={t.demoClose}>
            ×
          </button>
        </header>
        <DemoWorkspace t={t} mode={mode} />
      </div>
    </div>
  )
}

function DemoWorkspace({ t, mode }: { t: Copy; mode: DemoMode }) {
  const title =
    mode === 'translate' ? t.demoTranslate : mode === 'interview' ? t.demoInterview : 'AI Listening Assistant'

  return (
    <div className="demo-app">
      <div className="demo-tb">
        <span className="demo-brand">
          <svg width="18" height="18" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <path
              d="M26 88 V32 A13 13 0 0 1 52 32 L78 58"
              stroke="#f5f8ff"
              strokeWidth="9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M58 38 Q66 29 81 34 V60" stroke="#f5f8ff" strokeWidth="9" strokeLinecap="round" />
            <circle cx="81" cy="70" r="4.5" fill="#22d3ee" />
          </svg>
          Nod
        </span>
        <span className="demo-mode-pill">{title}</span>
        <span className="demo-lang">EN</span>
        <span className="demo-live">
          <i />
          {t.demoListen}
          <em>00:04:12</em>
        </span>
      </div>
      <div className="demo-body">
        <aside className="demo-rail" aria-hidden="true">
          <span className="demo-mic" />
          <span />
          <span />
          <span />
        </aside>
        {mode === 'meeting' && <MeetingDemo t={t} />}
        {mode === 'translate' && <TranslateDemo t={t} />}
        {mode === 'interview' && <InterviewDemo t={t} />}
      </div>
    </div>
  )
}

function MeetingDemo({ t }: { t: Copy }) {
  return (
    <div className="demo-work split">
      <section>
        <span className="demo-kicker">{t.demoListen}</span>
        <article>
          <b>{t.demoMaya}</b>
          <p>{t.demoMeetL1}</p>
          <em>{t.demoMeetL1tr}</em>
        </article>
        <article>
          <b>{t.demoKen}</b>
          <p>{t.demoMeetL2}</p>
          <em>{t.demoMeetL2tr}</em>
        </article>
        <article>
          <b>{t.demoPriya}</b>
          <p>{t.demoMeetL3}</p>
          <em>{t.demoMeetL3tr}</em>
        </article>
      </section>
      <section className="notes">
        <span className="demo-kicker">{t.demoNotes}</span>
        <h4>{t.demoDecisions}</h4>
        <p>{t.demoMeetD}</p>
        <h4>{t.demoActions}</h4>
        <p>{t.demoMeetA}</p>
        <h4>{t.demoFollow}</h4>
        <p>{t.demoMeetF}</p>
      </section>
    </div>
  )
}

function TranslateDemo({ t }: { t: Copy }) {
  return (
    <div className="demo-work captions">
      <span className="demo-kicker">{t.demoCaptions}</span>
      <div className="demo-pair-head">
        <b>EN</b>
        <span>⇄</span>
        <b>ZH</b>
      </div>
      <article className="cap">
        <p>{t.previewTrLine}</p>
        <em>{t.previewTrTr}</em>
      </article>
      <article className="cap">
        <p>{t.previewMeetLine}</p>
        <em>{t.previewMeetTr}</em>
      </article>
      <article className="cap">
        <p>{t.demoMeetL2}</p>
        <em>{t.demoMeetL2tr}</em>
      </article>
    </div>
  )
}

function InterviewDemo({ t }: { t: Copy }) {
  return (
    <div className="demo-work split">
      <section>
        <span className="demo-kicker">{t.demoQA}</span>
        <article className="q">
          <b>{t.demoInterviewer}</b>
          <p>{t.demoIvQ1}</p>
        </article>
        <article>
          <b>{t.demoYou}</b>
          <p>{t.demoIvA1}</p>
        </article>
        <article className="q">
          <b>{t.demoInterviewer}</b>
          <p>{t.demoIvQ2}</p>
        </article>
        <article>
          <b>{t.demoYou}</b>
          <p>{t.demoIvA2}</p>
        </article>
      </section>
      <section className="notes">
        <span className="demo-kicker">{t.demoAsk}</span>
        <h4>{t.demoTakeaways}</h4>
        <p>{t.demoIvTake}</p>
        <h4>{t.previewSummary}</h4>
        <p>{t.previewIvSum}</p>
      </section>
    </div>
  )
}

export function FeatIcon({ name }: { name: 'mic' | 'lang' | 'spark' | 'lock' }) {
  if (name === 'lang') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3.4 10h13.2M10 2.8c2.2 2.4 2.2 12 0 14.4M10 2.8C7.8 5.2 7.8 14.8 10 17.2" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    )
  }
  if (name === 'spark') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 2.2 11.4 8 17 9.4 11.4 10.8 10 16.6 8.6 10.8 3 9.4 8.6 8 10 2.2z" fill="currentColor" />
      </svg>
    )
  }
  if (name === 'lock') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="4.4" y="8.6" width="11.2" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M7 8.6V6.4a3 3 0 0 1 6 0v2.2" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 11v-2M6.5 14V6M10 16.5V3.5M13.5 13V7M17 11V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function WatchIcon() {
  return <PlayIcon />
}
