import { useEffect, useState } from 'react'
import { sessionSaveKeep } from '../historyRestore'
import { IPHONE_COPY } from '../iphoneCopy'
import { isNativeApp } from '../native'

export default function SavePrompt({
  open,
  onKeep,
  onDiscard,
  onCancel,
  secondary = 'discard',
}: {
  open: boolean
  onKeep: (opts: { content: true; audio: boolean }) => void
  onDiscard: () => void
  onCancel?: () => void
  secondary?: 'discard' | 'cancel'
}) {
  const [audio, setAudio] = useState(true)
  const native = isNativeApp()

  useEffect(() => {
    if (open) setAudio(true)
  }, [open])

  if (!open) return null

  return (
    <div className="save-prompt" role="dialog" aria-label={IPHONE_COPY.saveTitle}>
      <div className="save-prompt-card">
        {!native && <div className="hist-kicker">Save session</div>}
        <h2>{IPHONE_COPY.saveTitle}</h2>
        <p>{IPHONE_COPY.saveBody}</p>
        {!native && (
          <label className="save-prompt-opt">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            <span>
              <b>{IPHONE_COPY.keepRecording}</b>
              {IPHONE_COPY.keepRecordingHelp}
            </span>
          </label>
        )}
        <div className="save-prompt-actions">
          <button
            type="button"
            className="save-prompt-discard"
            onClick={secondary === 'cancel' ? (onCancel ?? onDiscard) : onDiscard}
          >
            {secondary === 'cancel' ? IPHONE_COPY.saveCancel : IPHONE_COPY.saveNo}
          </button>
          {onCancel && secondary === 'discard' ? (
            <button type="button" className="save-prompt-discard" onClick={onCancel}>
              {IPHONE_COPY.moreCancel}
            </button>
          ) : null}
          <button type="button" className="save-prompt-keep" onClick={() => onKeep(sessionSaveKeep({ audio: native ? true : audio }))}>
            {IPHONE_COPY.saveYes}
          </button>
        </div>
      </div>
    </div>
  )
}
