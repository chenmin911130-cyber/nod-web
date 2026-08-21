interface Props {
  value: number
  onChange: (n: number) => void
}

const clamp = (n: number) => Math.min(100, Math.max(10, Math.round(n)))

export default function OpacityBar({ value, onChange }: Props) {
  const pct = ((value - 10) / 90) * 100
  return (
    <div className="opacity-bar no-drag">
      <span className="op-readout">{value}%</span>
      <input
        type="range"
        className="op-slider"
        min={10}
        max={100}
        step={1}
        value={value}
        style={{ ['--op' as string]: `${pct}%` }}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
    </div>
  )
}
