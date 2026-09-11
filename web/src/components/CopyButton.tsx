import type { ReactNode, MouseEvent } from 'react'
import { copyFlashText, useCopyFlash, type CopyResult } from '../copyFeedback'

function CopyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.2" y="5.2" width="7.4" height="8.2" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.4 10.6V3.8A1.4 1.4 0 0 1 4.8 2.4h5.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function CopyCheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.4 8.4 6.6 11.4 12.6 4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CopyFlashHint({ result }: { result: CopyResult | null }) {
  if (!result) return null
  return (
    <span
      className={`copy-flash-nearby${result === 'ok' ? '' : ' is-fail'}`}
      role="status"
      aria-live="polite"
    >
      {copyFlashText(result)}
    </span>
  )
}

export function CopyButton({
  text,
  idle,
  className,
  title,
  stopPropagation,
  leadingIcon,
}: {
  text: string
  idle: string
  className?: string
  title?: string
  stopPropagation?: boolean
  leadingIcon?: boolean
}) {
  const { flash, runCopy, label } = useCopyFlash()
  const result = flash?.key === 'copy' ? flash.result : null
  const empty = !(text || '').trim()
  const shown = label('copy', idle)
  return (
    <button
      type="button"
      className={`${className || ''}${result === 'ok' ? ' copy-ok' : ''}${result === 'fail' || result === 'empty' ? ' copy-fail' : ''}`}
      disabled={empty}
      title={title || idle}
      aria-label={empty ? copyFlashText('empty') : shown}
      aria-live="polite"
      onClick={(e: MouseEvent) => {
        if (stopPropagation) e.stopPropagation()
        runCopy('copy', text)
      }}
    >
      {leadingIcon ? (result === 'ok' ? <CopyCheckIcon /> : <CopyGlyph />) : null}
      {shown}
    </button>
  )
}

export function CopyIconButton({
  text,
  className,
  title,
}: {
  text: string
  className?: string
  title: string
}) {
  const { flash, runCopy } = useCopyFlash()
  const result = flash?.key === 'copy' ? flash.result : null
  const empty = !(text || '').trim()
  const status = result ? copyFlashText(result) : ''
  return (
    <button
      type="button"
      className={`${className || ''}${result === 'ok' ? ' copy-ok' : ''}${result === 'fail' || result === 'empty' ? ' copy-fail' : ''}`}
      title={result ? copyFlashText(result) : title}
      aria-label={result ? copyFlashText(result) : title}
      disabled={empty}
      onClick={(e) => {
        e.stopPropagation()
        runCopy('copy', text)
      }}
    >
      {result === 'ok' ? <CopyCheckIcon /> : <CopyGlyph />}
      <span className="copy-sr" role="status" aria-live="polite">{status}</span>
    </button>
  )
}

export function CopyBodyHit({
  text,
  className,
  title,
  children,
  disabled,
}: {
  text: string
  className?: string
  title?: string
  children: ReactNode
  disabled?: boolean
}) {
  const { flash, runCopy } = useCopyFlash()
  const result = flash?.key === 'copy' ? flash.result : null
  return (
    <button
      type="button"
      className={className}
      title={title}
      disabled={disabled}
      onClick={() => runCopy('copy', text)}
    >
      {children}
      <CopyFlashHint result={result} />
    </button>
  )
}

export function ShareOrCopyButton({
  text,
  idle,
  className,
}: {
  text: string
  idle: string
  className?: string
}) {
  const { flash, runShare, label } = useCopyFlash()
  const result = flash?.key === 'share' ? flash.result : null
  const empty = !(text || '').trim()
  return (
    <button
      type="button"
      className={`${className || ''}${result === 'ok' ? ' copy-ok' : ''}${result === 'fail' || result === 'empty' ? ' copy-fail' : ''}`}
      disabled={empty}
      aria-live="polite"
      onClick={() => runShare('share', text)}
    >
      {label('share', idle)}
    </button>
  )
}
