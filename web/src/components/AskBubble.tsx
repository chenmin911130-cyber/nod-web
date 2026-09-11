export default function AskBubble({
  expanded,
  onClick,
  className = '',
}: {
  expanded?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      className={`iphone-ask-bubble${className ? ` ${className}` : ''}`}
      aria-label="Ask"
      aria-expanded={expanded}
      onClick={onClick}
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
