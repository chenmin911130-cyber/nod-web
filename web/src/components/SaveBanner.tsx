import { IPHONE_COPY } from '../iphoneCopy'

export default function SaveBanner({
  status,
  onSave,
  onNotNow,
  onRetry,
}: {
  status: 'undecided' | 'saving' | 'saved' | 'failed'
  onSave: () => void
  onNotNow: () => void
  onRetry: () => void
}) {
  if (status === 'saved') return null

  if (status === 'saving') {
    return (
      <div className="save-banner" aria-live="polite">
        <div className="save-banner-row">
          <span className="save-banner-spin" aria-hidden="true" />
          <b>{IPHONE_COPY.saveSaving}</b>
        </div>
        <div className="save-banner-actions">
          <button type="button" className="save-banner-notnow" disabled>
            {IPHONE_COPY.saveNotNow}
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
            {IPHONE_COPY.saveNotNow}
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
      <b>{IPHONE_COPY.saveBannerTitle}</b>
      <div className="save-banner-actions">
        <button type="button" className="save-banner-notnow" onClick={onNotNow}>
          {IPHONE_COPY.saveNotNow}
        </button>
        <button type="button" className="save-banner-save" onClick={onSave}>
          {IPHONE_COPY.saveYes}
        </button>
      </div>
    </div>
  )
}
