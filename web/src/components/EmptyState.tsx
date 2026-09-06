import type { ReactNode } from 'react'

interface Props {
  title: string
  sub?: string
  shortcuts?: Array<{ key: string; label: string }>
  compact?: boolean
  icon?: ReactNode
}

export default function EmptyState({ title, sub, shortcuts, compact, icon }: Props) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      {icon ? (
        <div className="empty-icon">{icon}</div>
      ) : !compact ? (
        <div className="empty-orbit">
          <svg width="74" height="74" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <path d="M26 88 V32 A13 13 0 0 1 52 32 L78 58" stroke="rgba(245,248,255,0.92)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M58 38 Q66 29 81 34 V60" stroke="rgba(245,248,255,0.92)" strokeWidth="9" strokeLinecap="round" />
            <circle cx="81" cy="70" r="4.5" fill="#00d2ff" />
          </svg>
        </div>
      ) : null}
      <div className="empty-title">{title}</div>
      {sub ? <div className="empty-sub">{sub}</div> : null}
      {shortcuts && shortcuts.length > 0 && (
        <div className="empty-shortcuts">
          {shortcuts.map((s, i) => (
            <span key={s.key}>
              {i > 0 && <span className="sep">·</span>}
              <b>{s.key}</b>
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
