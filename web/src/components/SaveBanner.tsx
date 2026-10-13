import { IPHONE_COPY } from '../iphoneCopy'

export default function SaveBanner({
  status,
  onSave,
  onNotNow,
  onRetry,
  title,
  detail,
  declineLabel,
  undo,
}: {
  status: 'undecided' | 'saving' | 'saved' | 'failed'
  onSave: () => void
  onNotNow: () => void
  onRetry: () => void
  title?: string
  detail?: string
  declineLabel?: string
  undo?: { onUndo: () => void; secondsLeft: number }
}) {
  if (status === 'saved') return null
  const heading = title ?? IPHONE_COPY.saveBannerTitle
  const decline = declineLabel ?? (status === 'undecided' ? IPHONE_COPY.saveNo : IPHONE_COPY.saveNotNow)

  if (undo && status === 'undecided') {
    return (
      <div className="save-banner" aria-live="polite">
        <b>{IPHONE_COPY.saveDiscardedTitle}</b>
        {undo.secondsLeft > 0 ? <p className="save-banner-detail">{undo.secondsLeft}</p> : null}
        <div className="save-banner-actions">
          <button type="button" className="save-banner-notnow" onClick={undo.onUndo}>
            {IPHONE_COPY.saveUndo}
          </button>
        </div>
      </div>
    )
  }

  if (status === 'saving') {
    return (
      <div className="save-banner" aria-live="polite">
        <div className="save-banner-row">
          <span className="save-banner-spin" aria-hidden="true" />
          <b>{IPHONE_COPY.saveSaving}</b>
        </div>
        <div className="save-banner-actions">
          <button type="button" className="save-banner-notnow" disabled>
            {decline}
          </button>
          <button type="button" className="save-banner-save" disabled>
            {IPHONE_COPY.saveYes}
          </button>
        </div>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className="save-banner" aria-live="polite">
        <b>{IPHONE_COPY.saveFailed}</b>
        <div className="save-banner-actions">
          <button type="button" className="save-banner-notnow" onClick={onNotNow}>
            {decline}
          </button>
          <button type="button" className="save-banner-save" onClick={onRetry}>
            {IPHONE_COPY.saveRetry}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="save-banner">
      <b>{heading}</b>
      {detail ? <p className="save-banner-detail">{detail}</p> : null}
      <div className="save-banner-actions">
        <button type="button" className="save-banner-notnow" onClick={onNotNow}>
          {decline}
        </button>
        <button type="button" className="save-banner-save" onClick={onSave}>
          {IPHONE_COPY.saveYes}
        </button>
      </div>
    </div>
  )
}
