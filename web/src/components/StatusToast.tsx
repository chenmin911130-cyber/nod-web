import { useEffect, useState } from 'react'
import { statusIsAmbient } from '../statusToast'

interface Props {
  text: string
}

export default function StatusToast({ text }: Props) {
  const [msg, setMsg] = useState('')
  const [on, setOn] = useState(false)

  useEffect(() => {
    if (statusIsAmbient(text)) return
    setMsg(text)
    setOn(true)
  }, [text])

  // Countdown lives in its own effect: an ambient status arriving right after
  // (e.g. Generating…) must not cancel the hide timer, or the previous toast
  // ("Answering…") sticks on screen forever and looks like a hang.
  useEffect(() => {
    if (!on) return
    const id = window.setTimeout(() => setOn(false), 2000)
    return () => window.clearTimeout(id)
  }, [on, msg])

  if (!on || !msg) return null
  return (
    <div className="status-toast" role="status">
      {msg}
    </div>
  )
}
