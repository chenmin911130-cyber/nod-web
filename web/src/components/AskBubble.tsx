import { useCallback, useEffect, useRef, useState } from 'react'
import { askBubbleBounds, askDragMoved, clampAskBubble } from '../listenChrome'

const BUBBLE_SIZE = 52
const BUBBLE_GUTTER = 12
/** The bubble never rides over the top chrome or the bottom bar. */
const BUBBLE_TOP_INSET = 56
const BUBBLE_BOTTOM_INSET = 76

function visibleHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

/**
 * #193 item 3: one bubble that opens/closes the Ask input and can be dragged
 * out of the way. A drag only moves it — it never toggles the input, never
 * sends, and never stops capture; a tap (travel under ASK_DRAG_SLOP) toggles.
 */
export default function AskBubble({
  expanded,
  onClick,
  className = '',
  draggable = false,
}: {
  expanded?: boolean
  onClick: () => void
  className?: string
  draggable?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const drag = useRef<{
    pointerId: number
    x: number
    y: number
    dx: number
    dy: number
    baseX: number
    baseY: number
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
    moved: boolean
  } | null>(null)
  const skipClick = useRef(false)
  const [offset, setOffset] = useState({ dx: 0, dy: 0 })

  const boundsFor = useCallback((size: number) => {
    return askBubbleBounds({
      viewportW: window.innerWidth,
      viewportH: visibleHeight(),
      size,
      gutter: BUBBLE_GUTTER,
      topInset: BUBBLE_TOP_INSET,
      bottomInset: BUBBLE_BOTTOM_INSET,
    })
  }, [])

  // A rotation, a keyboard, a dock change or a resize re-clamps the bubble into
  // the visible area instead of leaving it off-screen.
  const reclamp = useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const size = rect.width || BUBBLE_SIZE
    const bounds = boundsFor(size)
    const clamped = clampAskBubble({ x: rect.left, y: rect.top, ...bounds })
    setOffset((prev) => ({ dx: prev.dx + (clamped.x - rect.left), dy: prev.dy + (clamped.y - rect.top) }))
  }, [boundsFor])

  useEffect(() => {
    if (!draggable) return
    reclamp()
    const onLayout = () => reclamp()
    window.addEventListener('resize', onLayout)
    window.addEventListener('orientationchange', onLayout)
    window.visualViewport?.addEventListener('resize', onLayout)
    window.visualViewport?.addEventListener('scroll', onLayout)
    return () => {
      window.removeEventListener('resize', onLayout)
      window.removeEventListener('orientationchange', onLayout)
      window.visualViewport?.removeEventListener('resize', onLayout)
      window.visualViewport?.removeEventListener('scroll', onLayout)
    }
  }, [draggable, reclamp, expanded])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!draggable) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    drag.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: offset.dx,
      dy: offset.dy,
      // `rect` already carries the current translate, so the anchor for this
      // gesture is the UNtranslated position — adding the accumulated offset
      // again would double-count it and make the clamp fire early (a second
      // drag towards the edge then could not even be pulled back).
      baseX: rect.left - offset.dx,
      baseY: rect.top - offset.dy,
      bounds: boundsFor(rect.width || BUBBLE_SIZE),
      moved: false,
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const nextDx = d.dx + (e.clientX - d.x)
    const nextDy = d.dy + (e.clientY - d.y)
    if (!d.moved) {
      if (!askDragMoved({ dx: nextDx - d.dx, dy: nextDy - d.dy })) return
      d.moved = true
      try {
        ref.current?.setPointerCapture(e.pointerId)
      } catch {
        // capture is best-effort
      }
    }
    const clamped = clampAskBubble({ x: d.baseX + nextDx, y: d.baseY + nextDy, ...d.bounds })
    setOffset({ dx: clamped.x - d.baseX, dy: clamped.y - d.baseY })
  }
  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    drag.current = null
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId)
    if (d?.moved) skipClick.current = true
  }
  // A cancelled gesture must NOT arm the click-swallow: the browser fires no
  // click for it, so the flag would sit there and eat the user's NEXT tap.
  const cancelDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    drag.current = null
    skipClick.current = false
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId)
  }
  const handleClick = () => {
    if (skipClick.current) {
      skipClick.current = false
      return
    }
    onClick()
  }

  return (
    <button
      ref={ref}
      type="button"
      className={`iphone-ask-bubble${className ? ` ${className}` : ''}${draggable ? ' draggable' : ''}`}
      style={draggable ? { transform: `translate(${offset.dx}px, ${offset.dy}px)` } : undefined}
      aria-label="Ask"
      aria-expanded={expanded}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
      onClick={handleClick}
    >
      <svg width="22" height="22" viewBox="0 0 24 22" fill="none" aria-hidden="true">
        <path
          d="M4.2 3.2C4.2 2 5.2 1 6.4 1h11.2C18.8 1 19.8 2 19.8 3.2v8.2c0 1.2-1 2.2-2.2 2.2H11l-4.6 3.4v-3.4H6.4c-1.2 0-2.2-1-2.2-2.2V3.2z"
          fill="currentColor"
        />
      </svg>
    </button>
  )
}
