import { pinPodfile } from './iosWorktreePods.mjs'

function eq(got, want, label) {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
}

const escaped = `
require_relative '../../../../../Users/minchen/Projects/nod-web/node_modules/@capacitor/ios/scripts/pods_helpers'
pod 'Capacitor', :path => '../../../../../Users/minchen/Projects/nod-web/node_modules/@capacitor/ios'
pod 'NodMic', :path => '../../../../../Users/minchen/Projects/nod-web/plugins/nod-mic'
pod 'NodWatch', :path => '../../../../../Users/minchen/Projects/nod-web/plugins/nod-watch'
pod 'NodAuth', :path => '../../../../../Users/minchen/Projects/nod-web/plugins/nod-auth'
`

const pinned = pinPodfile(escaped)
if (pinned.includes('Projects/nod-web')) {
  throw new Error('pinPodfile must not keep the dirty checkout path')
}
eq(
  /pod 'NodMic', :path => '([^']+)'/.exec(pinned)[1],
  '../../plugins/nod-mic',
  'NodMic stays in this worktree',
)
eq(
  /pod 'NodWatch', :path => '([^']+)'/.exec(pinned)[1],
  '../../plugins/nod-watch',
  'NodWatch stays in this worktree',
)
eq(
  /require_relative '([^']+)'/.exec(pinned)[1],
  '../../node_modules/@capacitor/ios/scripts/pods_helpers',
  'pods_helpers stays relative',
)

console.log('iosWorktreePods.test.mjs ok')
