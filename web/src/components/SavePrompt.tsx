import { useEffect, useState } from 'react'
import { sessionSaveKeep } from '../historyRestore'

export default function SavePrompt({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean
  onKeep: (opts: { content: true; audio: boolean }) => void
  onDiscard: () => void
}) {
  const [audio, setAudio] = useState(true)

  useEffect(() => {
    if (open) setAudio(true)
  }, [open])

  if (!open) return null

  return (
    <div className="save-prompt" role="dialog" aria-label="Save session">
      <div className="save-prompt-card">
        <div className="hist-kicker">Save session</div>
        <h2>Save to History?</h2>
        <p>This session will stay in History so you can open it again.</p>
        <label className="save-prompt-opt">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          <span>
            <b>Keep recording</b>
            The audio from this session
          </span>
        </label>
        <div className="save-prompt-actions">
          <button type="button" className="save-prompt-keep" onClick={() => onKeep(sessionSaveKeep({ audio }))}>
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
