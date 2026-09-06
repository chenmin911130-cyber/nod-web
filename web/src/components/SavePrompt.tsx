import { useEffect, useState } from 'react'
import { sessionSaveKeep } from '../historyRestore'
import { IPHONE_COPY } from '../iphoneCopy'
import { isNativeApp } from '../native'

export default function SavePrompt({
  open,
  onKeep,
  onDiscard,
  restoreBody,
}: {
  open: boolean
  onKeep: (opts: { content: true; audio: boolean }) => void
  onDiscard: () => void
  restoreBody?: string | null
}) {
  const [audio, setAudio] = useState(true)
  const native = isNativeApp()
  const restore = Boolean(restoreBody)

  useEffect(() => {
    if (open) setAudio(true)
  }, [open])

  if (!open) return null

  return (
    <div className="save-prompt" role="dialog" aria-label={restore ? IPHONE_COPY.saveRestoreTitle : IPHONE_COPY.saveTitle}>
      <div className="save-prompt-card">
        {!native && <div className="hist-kicker">{restore ? IPHONE_COPY.saveRestoreKicker : 'Save session'}</div>}
        <h2>{restore ? IPHONE_COPY.saveRestoreTitle : IPHONE_COPY.saveTitle}</h2>
        <p>{restore ? restoreBody : IPHONE_COPY.saveBody}</p>
        {!native && !restore && (
          <label className="save-prompt-opt">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            <span>
              <b>{IPHONE_COPY.keepRecording}</b>
              {IPHONE_COPY.keepRecordingHelp}
            </span>
          </label>
        )}
        <div className="save-prompt-actions">
          <button type="button" className="save-prompt-discard" onClick={onDiscard}>
            {IPHONE_COPY.saveNo}
          </button>
          <button type="button" className="save-prompt-keep" onClick={() => onKeep(sessionSaveKeep({ audio: native ? true : audio }))}>
            {IPHONE_COPY.saveYes}
          </button>
        </div>
      </div>
    </div>
  )
}

export function SaveBanner({
  status,
  onSave,
  onDiscard,
}: {
  status?: 'undecided' | 'saving' | 'saved'
  onSave: () => void
  onDiscard: () => void
}) {
  if (status === 'saving') {
    return (
      <div className="save-banner" role="status">
        <span>{IPHONE_COPY.saveSaving}</span>
      </div>
    )
  }
  if (status === 'saved') {
    return (
      <div className="save-banner saved" role="status">
        <span>{IPHONE_COPY.saveSaved}</span>
      </div>
    )
  }
  return (
    <div className="save-banner" role="region" aria-label={IPHONE_COPY.saveBanner}>
      <button type="button" className="save-banner-keep" onClick={onSave}>
        {IPHONE_COPY.saveBanner}
      </button>
      <button type="button" className="save-banner-discard" onClick={onDiscard}>
        {IPHONE_COPY.saveNo}
      </button>
    </div>
  )
}
