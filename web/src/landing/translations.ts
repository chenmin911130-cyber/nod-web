export type Lang = 'zh' | 'en'

export type ModeId = 'interview' | 'meeting' | 'translate'

export interface ModeCopy {
  id: ModeId
  label: string
  title: string
  desc: string
}

export interface Copy {
  heroTitle: string
  heroSub: string
  claims: [string, string, string]
  cta: string
  ctaSub: string
  modesTitle: string
  modes: ModeCopy[]
  benefitsTitle: string
  benefits: Array<{ title: string; desc: string }>
  footer: string
  langToggle: string
  openApp: string
}

export const COPY: Record<Lang, Copy> = {
  zh: {
    heroTitle: '开口就懂，随时能答',
    heroSub: '浏览器打开，三十秒开始。面试、会议、交传，一个页面搞定。',
    claims: ['免安装', '中英交传', '面试和会议同一套'],
    cta: '开始使用',
    ctaSub: '无需下载，打开即用',
    modesTitle: '三种场景，一个产品',
    modes: [
      {
        id: 'interview',
        label: 'Interview',
        title: '面试模式',
        desc: '听问题，出回答。技术题、行为题都能帮你组织语言，直接照着说。',
      },
      {
        id: 'meeting',
        label: 'Meeting',
        title: '会议模式',
        desc: '边听边记，实时转写。会后一键生成要点、决策和行动项。',
      },
      {
        id: 'translate',
        label: 'Translate',
        title: '交传模式',
        desc: '对方说英文，你先看到中文理解，再拿到能开口说的英文回复。',
      },
    ],
    benefitsTitle: '为什么选 Nod',
    benefits: [
      {
        title: '打开浏览器就能用',
        desc: '不用装客户端，不用配环境。打开链接，授权麦克风，三十秒进入状态。',
      },
      {
        title: '面试 + 会议 + 交传',
        desc: '不用在三个工具之间切换。同一个界面，按场景切换模式就行。',
      },
      {
        title: '跨语言，不是字幕',
        desc: '听一种语言，帮你用另一种语言回应。交传式理解，不是简单实时字幕。',
      },
    ],
    footer: 'Nod · 浏览器里的实时语音助手',
    langToggle: 'EN',
    openApp: '打开应用',
  },
  en: {
    heroTitle: 'Understand fast. Answer ready.',
    heroSub: 'Open your browser, start in 30 seconds. Interview, meeting, and translation — one product.',
    claims: ['No install', 'Cross-language', 'One app, three modes'],
    cta: 'Get started',
    ctaSub: 'No download — just open and go',
    modesTitle: 'Three modes, one product',
    modes: [
      {
        id: 'interview',
        label: 'Interview',
        title: 'Interview mode',
        desc: 'Hear the question, get a spoken-ready answer. Technical and behavioral — organized for you.',
      },
      {
        id: 'meeting',
        label: 'Meeting',
        title: 'Meeting mode',
        desc: 'Live transcript while you listen. One tap for key points, decisions, and action items.',
      },
      {
        id: 'translate',
        label: 'Translate',
        title: 'Translate mode',
        desc: 'They speak one language — you see understanding in yours, then a reply you can say back.',
      },
    ],
    benefitsTitle: 'Why Nod',
    benefits: [
      {
        title: 'Browser-only, no install',
        desc: 'No desktop app, no setup. Open the link, allow the mic, and you are in within 30 seconds.',
      },
      {
        title: 'Interview + Meeting + Translate',
        desc: 'Stop juggling three tools. Same UI, switch modes for the moment you are in.',
      },
      {
        title: 'Cross-language, not just captions',
        desc: 'Listen in language A, get help speaking language B. Consecutive-style help, not raw subtitles.',
      },
    ],
    footer: 'Nod · Real-time voice assistant in your browser',
    langToggle: '中',
    openApp: 'Open app',
  },
}
