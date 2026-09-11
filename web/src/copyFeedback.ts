import { useCallback, useEffect, useRef, useState } from 'react'
import { copyText } from './historyRestore'

export const COPY_OK_MS = 1500
export const COPY_FAIL_MS = 4000
export const COPY_OK_LABEL = '✓ Copied'
export const COPY_FAIL_LABEL = "Couldn't copy. Try again."
export const COPY_EMPTY_LABEL = 'Nothing to copy.'

export type CopyResult = 'ok' | 'fail' | 'empty'
export type ShareCopyResult = 'shared' | 'copied' | 'fail' | 'empty' | 'aborted'

export type CopyFlash = { key: string; result: CopyResult }

export function copyHoldMs(result: CopyResult): number {
  return result === 'ok' ? COPY_OK_MS : COPY_FAIL_MS
}

export function copyFlashText(result: CopyResult): string {
  if (result === 'ok') return COPY_OK_LABEL
  if (result === 'fail') return COPY_FAIL_LABEL
  return COPY_EMPTY_LABEL
}

export function copyButtonLabel(idle: string, result: CopyResult | null, active: boolean): string {
  if (!active || !result) return idle
  return copyFlashText(result)
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

export async function copySnapshot(
  text: string,
  copy: (text: string) => Promise<boolean> = copyText,
): Promise<CopyResult> {
  if (!(text || '').trim()) return 'empty'
  return (await copy(text)) ? 'ok' : 'fail'
}

export async function shareOrCopy(
  text: string,
  opts?: {
    share?: (data: ShareData) => Promise<void>
    copy?: (text: string) => Promise<boolean>
  },
): Promise<ShareCopyResult> {
  const body = (text || '').trim()
  if (!body) return 'empty'
  const copy = opts?.copy ?? copyText
  const share = opts && 'share' in opts
    ? opts.share
    : typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      ? (data: ShareData) => navigator.share(data)
      : undefined
  if (share) {
    try {
      await share({ text: body })
      return 'shared'
    } catch (err) {
      if (isAbortError(err)) return 'aborted'
      return (await copy(body)) ? 'copied' : 'fail'
    }
  }
  return (await copy(body)) ? 'copied' : 'fail'
}

export function shareCopyToFlash(result: ShareCopyResult): CopyResult | null {
  if (result === 'shared' || result === 'aborted') return null
  if (result === 'copied') return 'ok'
  if (result === 'empty') return 'empty'
  return 'fail'
}

export function useCopyFlash() {
  const [flash, setFlash] = useState<CopyFlash | null>(null)
  const gen = useRef(0)
  const timer = useRef(0)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const show = useCallback((key: string, result: CopyResult, token: number) => {
    setFlash({ key, result })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (gen.current === token) setFlash(null)
    }, copyHoldMs(result))
  }, [])

  const reset = useCallback(() => {
    gen.current += 1
    window.clearTimeout(timer.current)
    setFlash(null)
  }, [])

  const runCopy = useCallback((key: string, text: string) => {
    gen.current += 1
    const token = gen.current
    void copySnapshot(text).then((result) => {
      if (token !== gen.current) return
      show(key, result, token)
    })
  }, [show])

  const runShare = useCallback((key: string, text: string) => {
    gen.current += 1
    const token = gen.current
    void shareOrCopy(text).then((result) => {
      if (token !== gen.current) return
      const next = shareCopyToFlash(result)
      if (!next) {
        setFlash(null)
        return
      }
      show(key, next, token)
    })
  }, [show])

  const label = useCallback(
    (key: string, idle: string) => copyButtonLabel(idle, flash?.key === key ? flash.result : null, flash?.key === key),
    [flash],
  )

  return { flash, runCopy, runShare, reset, label }
}
