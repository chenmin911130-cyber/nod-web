/** Last digit of the speaker id → S1 / S2. Letter-only ids (A/B) map A→1. */
export function speakerAvatarLabel(speaker: string): string {
  const id = speaker.trim()
  if (!id) return ''
  const digit = id.match(/(\d)(?!.*\d)/)
  if (digit) return `S${digit[1]}`
  const letter = id.match(/[A-Za-z](?!.*[A-Za-z])/)
  if (letter) {
    const n = ((letter[0].toUpperCase().charCodeAt(0) - 65) % 9) + 1
    return `S${n}`
  }
  return 'S'
}

export default function SpeakerAvatar({
  speaker,
  size = 28,
}: {
  speaker: string
  size?: number
}) {
  const label = speakerAvatarLabel(speaker)
  if (!label) return null
  return (
    <span
      className="iphone-spk-avatar"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {label}
    </span>
  )
}
