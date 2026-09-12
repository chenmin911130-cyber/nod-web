/**
 * #219: the Live Q&A Think control — the `Think` label plus an iOS-style sliding
 * switch. It owns no state: the session's Think value lives in App and reaches
 * the server as `set_think`. Toggling never submits a question.
 *
 * Placement is the caller's business: the phone renders it in the recording
 * chrome next to the mode line (ListenPane), the wider layout keeps it inline
 * above the composer (AnswerPane).
 */
export default function ThinkSwitch({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={`think-toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label="Think"
      onClick={() => onToggle(!on)}
    >
      Think
      <span className="think-switch" aria-hidden="true">
        <span className="think-knob" />
      </span>
    </button>
  )
}
