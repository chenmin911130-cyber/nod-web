import { useCallback, useState } from 'react'

interface Props {
  hasLlm: boolean
  hasStt: boolean
}

export default function KeySetup({ hasLlm, hasStt }: Props) {
  const [dsKey, setDsKey] = useState('')
  const [aaKey, setAaKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = useCallback(() => {
    if (!dsKey.trim() && !aaKey.trim()) {
      setErr('请至少填写一个 key')
      return
    }
    setSaving(true)
    setErr('')
    window.api.send({
      type: 'save_keys',
      deepseek_key: dsKey.trim(),
      assemblyai_key: aaKey.trim(),
    })
    // 引擎会回 keys_status，父组件据此切走本面板；这里留个兜底复位
    setTimeout(() => setSaving(false), 1500)
  }, [dsKey, aaKey])

  const open = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    window.api.openExternal(url)
  }

  return (
    <div className="keysetup">
      <div className="keysetup-card">
        <div className="keysetup-title">Nod · 需要 API Keys</div>
        <p className="keysetup-desc">
          首次使用需填写两个 key。网页版优先读服务器环境变量；若没有，则保存在当前服务进程内存中，
          不会写进浏览器，也不会发给作者。
        </p>

        <label className="keysetup-field">
          <span>
            DeepSeek API Key · AI 回答{!hasLlm && <em className="keysetup-missing">（缺少）</em>}
          </span>
          <input
            type="password"
            placeholder="sk-…"
            value={dsKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setDsKey(e.target.value)}
          />
          <a href="https://platform.deepseek.com/api_keys" onClick={open('https://platform.deepseek.com/api_keys')}>
            获取 key → platform.deepseek.com
          </a>
        </label>

        <label className="keysetup-field">
          <span>
            AssemblyAI API Key · 语音转写{!hasStt && <em className="keysetup-missing">（缺少）</em>}
          </span>
          <input
            type="password"
            placeholder="粘贴 AssemblyAI key"
            value={aaKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAaKey(e.target.value)}
          />
          <a href="https://www.assemblyai.com/app" onClick={open('https://www.assemblyai.com/app')}>
            获取 key → assemblyai.com/app
          </a>
        </label>

        {err && <div className="keysetup-err">{err}</div>}
        <button className="keysetup-save" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存并开始'}
        </button>
        <p className="keysetup-note">
          没有 key？DeepSeek 与 AssemblyAI 都提供免费额度。Railway 部署时把 key 配在服务环境变量里即可跳过此页。
        </p>
      </div>
    </div>
  )
}

