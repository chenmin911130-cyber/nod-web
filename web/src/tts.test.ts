import { defaultTtsMode, nextLiveUtterances, shouldKickDrain, speechTapShouldStop } from './tts'

function eq<T>(got: T, want: T) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(defaultTtsMode(true, null), 'tap')
eq(defaultTtsMode(false, null), 'tap')
eq(defaultTtsMode(true, 'tap'), 'tap')
eq(defaultTtsMode(false, 'live'), 'live')

eq(nextLiveUtterances({
  live: false,
  workspaceMode: 'translate',
  translateOn: false,
  bindId: '',
  spoken: [],
  pairs: [{ id: '1', translation: 'hello' }],
  lines: [],
}), [])

eq(nextLiveUtterances({
  live: true,
  workspaceMode: 'translate',
  translateOn: false,
  bindId: '2',
  spoken: ['1'],
  pairs: [
    { id: '1', translation: 'old' },
    { id: '2', translation: 'busy' },
    { id: '3', translation: 'new line' },
    { id: '4', translation: 'same', passthrough: true },
  ],
  lines: [],
}), [{ id: '3', text: 'new line' }])

eq(nextLiveUtterances({
  live: true,
  workspaceMode: 'meeting',
  translateOn: true,
  bindId: '',
  spoken: [],
  pairs: [],
  lines: [
    { id: 'a', translation: '你好' },
    { id: 'b', translation: '' },
  ],
}), [{ id: 'meet:a', text: '你好' }])

eq(nextLiveUtterances({
  live: true,
  workspaceMode: 'interview',
  translateOn: false,
  bindId: '',
  spoken: [],
  pairs: [{ id: '1', translation: 'no' }],
  lines: [{ id: 'a', translation: 'no' }],
}), [])

eq(shouldKickDrain(true, 1), false)
eq(shouldKickDrain(false, 0), false)
eq(shouldKickDrain(false, 1), true)

eq(speechTapShouldStop(false), false)
eq(speechTapShouldStop(true), true)
