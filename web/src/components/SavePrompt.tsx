export default function SavePrompt({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean
  onKeep: () => void
  onDiscard: () => void
}) {
  if (!open) return null
  return (
    <div className="save-prompt" role="dialog" aria-label="Save session">
      <div className="save-prompt-card">
        <div className="hist-kicker">Session ended</div>
        <h2>Save this session to History?</h2>
        <p>Save keeps the transcript, answers, and audio. Discard deletes this session from History and cloud storage.</p>
        <div className="save-prompt-actions">
          <button type="button" className="save-prompt-keep" onClick={onKeep}>
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
