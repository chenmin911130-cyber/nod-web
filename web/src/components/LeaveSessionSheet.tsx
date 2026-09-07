import { useId } from 'react'
import { IPHONE_COPY } from '../iphoneCopy'
import PhoneSheet from './PhoneSheet'

export default function LeaveSessionSheet({
  open,
  capture,
  busy,
  onCancel,
  onSave,
  onDiscard,
}: {
  open: boolean
  capture: string
  busy: boolean
  onCancel: () => void
  onSave: () => void
  onDiscard: () => void
}) {
  const waitId = useId()
  const discardHelpId = useId()
  const recording = capture !== 'off'

  return (
    <PhoneSheet
      open={open}
      title={IPHONE_COPY.leaveTitle}
      subtitle={recording ? IPHONE_COPY.leaveSubRecording : IPHONE_COPY.leaveSubEnded}
      onClose={onCancel}
    >
      <div className="leave-sheet-actions">
        <button
          type="button"
          className="leave-sheet-save"
          disabled={busy}
          aria-describedby={busy ? waitId : undefined}
          onClick={onSave}
        >
          {IPHONE_COPY.leaveSave}
        </button>
        {busy ? (
          <p id={waitId} className="leave-sheet-wait">{IPHONE_COPY.leaveWaitAnswer}</p>
        ) : null}
        <button
          type="button"
          className="leave-sheet-discard"
          aria-describedby={discardHelpId}
          onClick={onDiscard}
        >
          {IPHONE_COPY.leaveDiscard}
        </button>
        <p id={discardHelpId} className="leave-sheet-discard-help">{IPHONE_COPY.leaveDiscardHelp}</p>
        <button type="button" className="leave-sheet-cancel" onClick={onCancel}>
          {IPHONE_COPY.moreCancel}
        </button>
      </div>
    </PhoneSheet>
  )
}
