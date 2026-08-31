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
    <span className="pet-mark" aria-hidden="true">
      <img className="pet-mark-photo" src="/pet-shiba.jpg" alt="" width={36} height={36} />
    </span>
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
    <div className={`pet-track${phase === 'bye' ? ' bye' : ''}`} role="status" aria-live="polite">
      <div className="pet-timer">
        <PetMark />
        <div className="pet-timer-copy">
          <span className="pet-timer-line">{line}</span>
          {phase !== 'hello' && <span className="pet-timer-clock">{clock}</span>}
        </div>
      </div>
    </div>
  )
}
