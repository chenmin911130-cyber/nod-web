import { useEffect, useRef, useState } from 'react'

const HELLO = "I'm listening."
const BYE = "I'll be here."
const FAREWELL_MS = 2200

function formatClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function PetMark() {
  return (
    <svg className="pet-mark" viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
      <ellipse cx="32" cy="40" rx="18" ry="16" fill="#1a334d" />
      <path d="M18 28c-2-10 6-16 10-8" fill="#1a334d" />
      <path d="M46 28c2-10-6-16-10-8" fill="#1a334d" />
      <path d="M18 28c-2-10 6-16 10-8" fill="none" stroke="#22d3ee" strokeWidth="1.4" />
      <path d="M46 28c2-10-6-16-10-8" fill="none" stroke="#22d3ee" strokeWidth="1.4" />
      <ellipse cx="32" cy="40" rx="18" ry="16" fill="none" stroke="#22d3ee" strokeWidth="1.6" />
      <circle cx="25" cy="38" r="2.2" fill="#f2f6ff" />
      <circle cx="39" cy="38" r="2.2" fill="#f2f6ff" />
      <circle cx="25.4" cy="37.6" r="0.7" fill="#0c1a2e" />
      <circle cx="39.4" cy="37.6" r="0.7" fill="#0c1a2e" />
      <path d="M29 45c2 2.4 4 2.4 6 0" stroke="#22d3ee" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}

export default function PetTimer({ listening }: { listening: boolean }) {
  const [phase, setPhase] = useState<'hidden' | 'hello' | 'live' | 'bye'>('hidden')
  const [ms, setMs] = useState(0)
  const started = useRef(0)
  const visible = phase !== 'hidden'

  useEffect(() => {
    if (listening) {
      started.current = Date.now()
      setMs(0)
      setPhase('hello')
      const t = window.setTimeout(() => setPhase((p) => (p === 'hello' ? 'live' : p)), 2200)
      return () => window.clearTimeout(t)
    }
    setPhase((p) => (p === 'hidden' ? 'hidden' : 'bye'))
    const t = window.setTimeout(() => setPhase('hidden'), FAREWELL_MS)
    return () => window.clearTimeout(t)
  }, [listening])

  useEffect(() => {
    if (!listening) return
    const id = window.setInterval(() => setMs(Date.now() - started.current), 250)
    return () => window.clearInterval(id)
  }, [listening])

  if (!visible) return null

  const line = phase === 'bye' ? BYE : HELLO
  const clock = formatClock(ms)

  return (
    <div className={`pet-timer${phase === 'bye' ? ' bye' : ''}`} role="status" aria-live="polite">
      <PetMark />
      <div className="pet-timer-copy">
        <span className="pet-timer-line">{line}</span>
        {phase !== 'hello' && <span className="pet-timer-clock">{clock}</span>}
      </div>
    </div>
  )
}
