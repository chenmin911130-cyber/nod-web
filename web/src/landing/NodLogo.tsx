export default function NodLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path
        d="M26 88 V32 A13 13 0 0 1 52 32 L78 58"
        stroke="#f5f8ff"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M58 38 Q66 29 81 34 V60"
        stroke="#f5f8ff"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle cx="81" cy="70" r="4.5" fill="#22d3ee" />
    </svg>
  )
}
