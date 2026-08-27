import type { AppState, MeetingLine, TranslatePair, Turn } from './types'

export type DemoScene = 'meeting' | 'meeting-notes' | 'translate' | 'interview'

export function readDemoScene(): DemoScene | null {
  if (typeof window === 'undefined') return null
  const q = new URLSearchParams(window.location.search).get('demo')
  if (q === 'meeting' || q === 'meeting-notes' || q === 'translate' || q === 'interview') return q
  return null
}

const MEETING_LINES: MeetingLine[] = [
  {
    id: 'm1',
    ts: '00:01:12',
    speaker: 'A',
    text: 'Let’s lock the launch window. I want beta on September 8.',
    translation: '先把上线窗口定下来。我希望 9 月 8 日进 beta。',
  },
  {
    id: 'm2',
    ts: '00:01:41',
    speaker: 'B',
    text: 'Park Japanese audio latency for Thursday. Do not block the beta on it.',
    translation: '日语音频延迟先放到周四。不要因为这个卡住 beta。',
  },
  {
    id: 'm3',
    ts: '00:02:08',
    speaker: 'C',
    text: 'I’ll send the customer email draft by Friday.',
    translation: '周五前我会发出客户邮件草稿。',
    marked: true,
  },
]

const MEETING_NOTES = JSON.stringify({
  summary: 'The team locked a September 8 beta by cutting admin export from v1.',
  keyPoints: [
    'Beta date is September 8.',
    'Export moves to 1.1.',
    'Japanese audio latency is parked.',
  ],
  decisions: ['Ship beta without admin export.'],
  actionItems: [{ text: 'Customer email draft by Friday', owner: 'Priya' }],
  importantDetails: ['Latency cited: about 1.4 seconds on Japanese audio.'],
  followUps: ['Thursday: reopen the JP latency ticket.'],
})

const TRANSLATE_PAIRS: TranslatePair[] = [
  {
    id: 't1',
    ts: '00:00:18',
    original: 'Let’s lock the launch window. I want beta on September 8.',
    translation: '先把上线窗口定下来。我希望 9 月 8 日进 beta。',
    from: 'en',
    to: 'zh',
  },
  {
    id: 't2',
    ts: '00:00:41',
    original: 'We should prioritize user onboarding flow improvements before the next release.',
    translation: '我们应该在下一次发布前，优先改进用户引导流程。',
    from: 'en',
    to: 'zh',
  },
  {
    id: 't3',
    ts: '00:01:06',
    original: 'Park Japanese audio latency for Thursday. Do not block the beta on it.',
    translation: '日语音频延迟先放到周四。不要因为这个卡住 beta。',
    from: 'en',
    to: 'zh',
  },
]

const INTERVIEW_TURNS: Turn[] = [
  {
    id: 'i1',
    q: 'Walk me through a product decision you owned.',
    a: 'I cut admin export from v1 so the September 8 beta could ship. We moved export to 1.1.',
  },
  {
    id: 'i2',
    q: 'What would you do in the first 30 days?',
    a: 'Talk to five users who dropped during onboarding, then ship one checklist fix.',
  },
]

export function applyDemoSeed(state: AppState): AppState {
  const scene = readDemoScene()
  if (!scene) return state

  const shared = {
    ...state,
    keys: { hasLlm: true, hasStt: true },
    status: 'Listening',
    run: 'listen' as const,
    view: 'workspace' as const,
    bilingual: true,
    lang: 'en' as const,
    translateTo: 'zh' as const,
    notesLang: 'zh' as const,
    heardLang: 'en' as const,
    meetingStartedAt: Date.now() - 167_000,
    meetingElapsedMs: 167_000,
    meetingEnded: false,
    micMuted: false,
  }

  if (scene === 'translate') {
    return {
      ...shared,
      workspaceMode: 'translate',
      translateFrom: 'en',
      translatePairs: TRANSLATE_PAIRS,
      currentQ: TRANSLATE_PAIRS[TRANSLATE_PAIRS.length - 1].original,
    }
  }

  if (scene === 'interview') {
    return {
      ...shared,
      workspaceMode: 'interview',
      listenScene: 'interview',
      autoOn: true,
      turns: INTERVIEW_TURNS,
      currentQ: INTERVIEW_TURNS[INTERVIEW_TURNS.length - 1].q,
      notesRaw: JSON.stringify({
        summary: 'Disagreement → test → ship with checklist',
        takeaways: ['Owns tradeoffs. Ships by cutting scope.', 'First 30 days: onboarding drop-off.'],
        keyPoints: ['Cut admin export from v1 to protect the September 8 beta.'],
        importantDetails: [],
        followUps: [],
      }),
    }
  }

  return {
    ...shared,
    workspaceMode: 'meeting',
    listenScene: 'meeting',
    translateOn: true,
    meetingLines: MEETING_LINES,
    speakerNames: { A: 'Maya', B: 'Ken', C: 'Priya' },
    speakerNameLocked: { A: true, B: true, C: true },
    notesRaw: MEETING_NOTES,
  }
}
