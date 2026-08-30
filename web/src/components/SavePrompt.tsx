import { useEffect, useState } from 'react'

export default function SavePrompt({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean
  onKeep: (opts: { content: boolean; audio: boolean }) => void
  onDiscard: () => void
}) {
  const [content, setContent] = useState(true)
  const [audio, setAudio] = useState(true)

  useEffect(() => {
    if (open) {
      setContent(true)
      setAudio(true)
    }
  }, [open])

  if (!open) return null

  const save = () => {
    if (!content && !audio) {
      onDiscard()
      return
    }
    onKeep({ content, audio })
  }

  return (
    <div className="save-prompt" role="dialog" aria-label="Save session">
      <div className="save-prompt-card">
        <div className="hist-kicker">Session ended</div>
        <h2>Save to History?</h2>
        <p>Choose what to keep so you can open it again from History.</p>
        <label className="save-prompt-opt">
          <input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} />
          <span>
            <b>Session content</b>
            Transcript, translations, and notes
          </span>
        </label>
        <label className="save-prompt-opt">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          <span>
            <b>Recording</b>
            The audio from this session
          </span>
        </label>
        <div className="save-prompt-actions">
          <button type="button" className="save-prompt-keep" onClick={save}>
            Save
          </button>
          <button type="button" className="save-prompt-discard" onClick={onDiscard}>
            Don&apos;t save
          </button>
        </div>
      </div>
    </div>
  )
}
