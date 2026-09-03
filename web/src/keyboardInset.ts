export type VisualBox = {
  height: number
  offsetTop: number
}

export type KeyboardFrame = {
  height: number
  shiftY: number
  overlap: number
  open: boolean
}

/** iOS toolbar / URL chrome can shrink the visual viewport a little. */
export const KEYBOARD_OPEN_PX = 80

export function keyboardOverlap(layoutHeight: number, visual: VisualBox | null): number {
  if (!visual) return 0
  return Math.max(0, Math.round(layoutHeight - visual.height - visual.offsetTop))
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function keyboardFrame(
  layoutHeight: number,
  visual: VisualBox | null,
  focused = false,
): KeyboardFrame {
  if (!visual) {
    return { height: Math.round(layoutHeight), shiftY: 0, overlap: 0, open: focused }
  }
  const overlap = keyboardOverlap(layoutHeight, visual)
  return {
    height: Math.max(1, Math.round(visual.height)),
    shiftY: Math.round(visual.offsetTop),
    overlap,
    open: focused || overlap >= KEYBOARD_OPEN_PX,
  }
}

export function applyKeyboardFrame(
  style: CSSStyleDeclaration,
  classList: DOMTokenList,
  frame: KeyboardFrame,
): void {
  style.setProperty('--vv-height', `${frame.height}px`)
  style.setProperty('--vv-shift', `${frame.shiftY}px`)
  style.setProperty('--kb-inset', `${frame.overlap}px`)
  classList.toggle('kb-open', frame.open)
}

function pinScroll(): void {
  window.scrollTo(0, 0)
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}

export function installKeyboardInset(): () => void {
  const root = document.documentElement
  const sync = () => {
    const vv = window.visualViewport
    applyKeyboardFrame(
      root.style,
      root.classList,
      keyboardFrame(
        window.innerHeight,
        vv ? { height: vv.height, offsetTop: vv.offsetTop } : null,
        isEditableTarget(document.activeElement),
      ),
    )
    pinScroll()
  }
  sync()
  const vv = window.visualViewport
  vv?.addEventListener('resize', sync)
  vv?.addEventListener('scroll', sync)
  window.addEventListener('focusin', sync)
  window.addEventListener('focusout', () => {
    requestAnimationFrame(sync)
  })
  window.addEventListener('orientationchange', sync)
  return () => {
    vv?.removeEventListener('resize', sync)
    vv?.removeEventListener('scroll', sync)
    window.removeEventListener('focusin', sync)
    window.removeEventListener('orientationchange', sync)
  }
}
