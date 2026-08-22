import type { ModeId } from './translations'
import './ModeDemo.css'

interface Props {
  mode: ModeId
  lang: 'zh' | 'en'
}

const DEMO: Record<ModeId, { zh: DemoData; en: DemoData }> = {
  interview: {
    zh: {
      status: 'Ready · F2 录音 / F3 听 / F4 清空',
      question: '请介绍一下你在上一个项目里负责的核心模块？',
      answer:
        '我主要负责用户认证和权限模块。先用 JWT 做无状态登录，再按角色做 RBAC。上线后登录失败率降了约 40%，这块也是我面试时最想展开讲的部分。',
      rail: ['听', '录', '复制', '清空'],
    },
    en: {
      status: 'Ready · F2 record / F3 listen / F4 clear',
      question: 'Can you walk me through the core module you owned in your last project?',
      answer:
        'I owned authentication and authorization. We used JWT for stateless login and RBAC by role. After launch, login failure rate dropped about 40% — that is the part I like to go deep on.',
      rail: ['Listen', 'Rec', 'Copy', 'Clear'],
    },
  },
  meeting: {
    zh: {
      status: 'Listening · 00:12:34',
      question: '张：下周发布窗口定在周三，后端接口周五前冻结。',
      answer:
        '要点\n· 发布窗口：下周三\n· 接口冻结：本周五\n\n决策\n· 先上核心流程，报表功能延后\n\n行动项\n· 李明：周五前完成 API 文档',
      rail: ['听', '录', '纪要', '导出'],
    },
    en: {
      status: 'Listening · 00:12:34',
      question: 'Alex: Release window is Wednesday; backend APIs freeze by Friday.',
      answer:
        'Key points\n· Release: next Wednesday\n· API freeze: this Friday\n\nDecisions\n· Ship core flow first; reports slip\n\nActions\n· Sam: API docs by Friday',
      rail: ['Listen', 'Rec', 'Summary', 'Export'],
    },
  },
  translate: {
    zh: {
      status: 'Captions · Auto → EN',
      question: 'Could you give us a quick overview of your experience with distributed systems?',
      answer:
        '我在分布式系统方面有三年经验，主要做消息队列和服务发现。最近的项目用 Kafka 做事件流，用 Consul 做服务注册，日均处理约两百万条消息。',
      rail: ['听', '录', '复制', '重试'],
      bilingual: true,
      originalLabel: 'EN',
      translationLabel: 'ZH 理解',
      replyLabel: 'EN 回复',
    },
    en: {
      status: 'Captions · Auto → ZH',
      question: '能简单介绍一下你在分布式系统方面的经验吗？',
      answer:
        'I have three years in distributed systems — mostly message queues and service discovery. Latest project used Kafka for events and Consul for registration, about 2M messages daily.',
      rail: ['Listen', 'Rec', 'Copy', 'Retry'],
      bilingual: true,
      originalLabel: 'ZH',
      translationLabel: 'EN understanding',
      replyLabel: 'ZH reply',
    },
  },
}

interface DemoData {
  status: string
  question: string
  answer: string
  rail: string[]
  bilingual?: boolean
  originalLabel?: string
  translationLabel?: string
  replyLabel?: string
}

export default function ModeDemo({ mode, lang }: Props) {
  const d = DEMO[mode][lang]

  return (
    <div className="mode-demo" aria-label="UI preview">
      <div className="mode-demo-window">
        <div className="mode-demo-titlebar">
          <div className="mode-demo-brand">
            <span className="mode-demo-brand-n">Nod</span>
            <span className="mode-demo-pills">
              {(['interview', 'meeting', 'translate'] as ModeId[]).map((m) => (
                <span key={m} className={`mode-demo-pill${m === mode ? ' active' : ''}`}>
                  {m === 'interview' ? 'Interview' : m === 'meeting' ? 'Meeting' : 'Translate'}
                </span>
              ))}
            </span>
          </div>
          <div className="mode-demo-lang">CH / EN</div>
        </div>

        <div className="mode-demo-body">
          <div className="mode-demo-rail">
            {d.rail.map((label, i) => (
              <div key={label} className={`mode-demo-rail-btn${i === 0 ? ' live' : ''}`}>
                {i === 0 && <span className="mode-demo-dot" />}
                {label}
              </div>
            ))}
          </div>

          <div className="mode-demo-main">
            {mode === 'translate' && d.bilingual ? (
              <>
                <div className="mode-demo-kicker">{d.status}</div>
                <div className="mode-demo-tr-row">
                  <div className="mode-demo-tr-col">
                    <div className="mode-demo-tr-label">{d.originalLabel}</div>
                    <div className="mode-demo-tr-text">{d.question}</div>
                  </div>
                  <div className="mode-demo-tr-col accent">
                    <div className="mode-demo-tr-label">{d.translationLabel}</div>
                    <div className="mode-demo-tr-text muted">
                      {lang === 'zh'
                        ? '能简单介绍一下你在分布式系统方面的经验吗？'
                        : 'Could you give us a quick overview of your experience with distributed systems?'}
                    </div>
                  </div>
                </div>
                <div className="mode-demo-answer-block">
                  <div className="mode-demo-kicker answer">{d.replyLabel}</div>
                  <div className="mode-demo-answer">{d.answer}</div>
                </div>
              </>
            ) : (
              <>
                <div className="mode-demo-kicker">{mode === 'meeting' ? 'Transcript' : 'Question'}</div>
                <div className="mode-demo-question">{d.question}</div>
                <div className="mode-demo-kicker answer">
                  {mode === 'meeting' ? 'Summary' : 'Answer'}
                </div>
                <div className="mode-demo-answer">{d.answer}</div>
              </>
            )}
          </div>
        </div>

        <div className="mode-demo-status">{d.status}</div>
      </div>
    </div>
  )
}
