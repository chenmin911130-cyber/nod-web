import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { ATTACH_ACCEPT, collectAttaches, type LocalAttach } from '../attach'

interface Props {
  files: LocalAttach[]
  onChange: (files: LocalAttach[]) => void
  disabled?: boolean
  children: ReactNode
}

export default function PromptAttach({ files, onChange, disabled, children }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [hint, setHint] = useState('')

  const pick = () => {
    if (disabled) return
    inputRef.current?.click()
  }

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    const result = await collectAttaches(list, files)
    onChange(result.files)
    setHint(result.error || '')
    if (inputRef.current) inputRef.current.value = ''
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (disabled) return
    void onFiles(e.dataTransfer.files)
  }

  return (
    <div
      className="prompt-block"
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDrop={onDrop}
    >
      {files.length > 0 && (
        <div className="attach-chips">
          {files.map((f) => (
            <span key={f.id} className={`attach-chip kind-${f.kind}`} title={f.name}>
              <span className="attach-chip-name">{f.name}</span>
              <button
                type="button"
                className="attach-chip-x"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((x) => x.id !== f.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {hint && <div className="attach-hint">{hint}</div>}
      <div className="prompt-row">
        <button
          className="prompt-plus"
          type="button"
          disabled={disabled}
          title="Attach Office, PDF, or image"
          aria-label="Attach Office, PDF, or image"
          onClick={pick}
        >
          +
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept={ATTACH_ACCEPT}
          onChange={(e) => void onFiles(e.target.files)}
        />
        {children}
      </div>
    </div>
  )
}
