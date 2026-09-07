import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const NEAR_PX = 240

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_PX
}

export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
): { stuck: boolean; hasNew: boolean; scrollToBottom: () => void } {
  const [stuck, setStuck] = useState(true)
  const [hasNew, setHasNew] = useState(false)
  const stuckRef = useRef(true)

  const markStuck = (next: boolean) => {
    stuckRef.current = next
    setStuck(next)
  }

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    markStuck(true)
    setHasNew(false)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const near = isNearBottom(el)
      markStuck(near)
      if (near) setHasNew(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (stuckRef.current) {
      const frame = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
      return () => cancelAnimationFrame(frame)
    }
    setHasNew(true)
    // Caller owns the dependency list (lines.length / partial / pane visibility).
  }, deps)

  return { stuck, hasNew, scrollToBottom }
}
