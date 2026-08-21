import { useEffect, useState } from 'react'

interface Props {
  text: string
}

function isAmbient(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return /^(Starting|Ready|Listening|Recording|Calibrat|Transcrib|Checking|Generating|Thinking)/i.test(t)
    || t.startsWith('I caught part')
}

export default function StatusToast({ text }: Props) {
  const [msg, setMsg] = useState('')
  const [on, setOn] = useState(false)

  useEffect(() => {
    if (isAmbient(text)) return
    setMsg(text)
    setOn(true)
    const id = window.setTimeout(() => setOn(false), 2000)
    return () => window.clearTimeout(id)
  }, [text])

  if (!on || !msg) return null
  return (
    <div className="status-toast" role="status">
      {msg}
    </div>
  )
}
