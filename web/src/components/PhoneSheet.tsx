import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false
    return el.tabIndex >= 0
  })
}

export default function PhoneSheet({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  returnFocusRef,
}: {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  returnFocusRef?: RefObject<HTMLElement>
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement ? active : null
    const first = focusables(panelRef.current)[0]
    first?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables(panelRef.current)
      if (items.length === 0) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey) {
        if (index <= 0) {
          e.preventDefault()
          items[items.length - 1]?.focus()
        }
      } else if (index === items.length - 1 || index < 0) {
        e.preventDefault()
        items[0]?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const back = returnFocusRef?.current || openerRef.current
      if (back && document.contains(back)) back.focus()
    }
  }, [open, onClose, returnFocusRef])

  if (!open) return null

  return (
    <div className="phone-sheet">
      <button type="button" className="phone-sheet-backdrop" aria-label="Close" onClick={onClose} />
      <div className="phone-sheet-dock">
        <div
          ref={panelRef}
          className="phone-sheet-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <span className="phone-sheet-handle" aria-hidden="true" />
          <div className="phone-sheet-head">
            <div className="phone-sheet-titles">
              <h2 id={titleId} className="phone-sheet-title">{title}</h2>
              {subtitle ? <p className="phone-sheet-sub">{subtitle}</p> : null}
            </div>
            <button type="button" className="phone-sheet-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="phone-sheet-body">{children}</div>
          {footer ? <div className="phone-sheet-footer">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}
