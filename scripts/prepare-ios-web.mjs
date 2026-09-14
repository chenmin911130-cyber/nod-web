import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Rewrite the native bootstrap page and set the iOS bundle (CFBundleVersion /
 * CURRENT_PROJECT_VERSION).
 *
 * NOD_IOS_BUNDLE pins the bundle to an explicit non-negative integer. ios-deliver
 * sets it so a delivery carries exactly the requested value instead of whatever an
 * auto-increment happened to produce. When it is unset the historical behaviour is
 * kept: increment by one, so a hand-run `cap:sync` and other flows are unchanged.
 */

const indexPath = resolve(process.cwd(), 'web/dist/index.html')
writeFileSync(
  indexPath,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#05070a" />
    <title>Nodpilot</title>
    <style>html,body{margin:0;background:#05070a;height:100%}</style>
    <script>
      location.replace('./app.html' + location.search + location.hash)
    </script>
  </head>
  <body></body>
</html>
`,
)
process.stdout.write('prepare-ios-web: native app boots into app.html\n')

const pbx = resolve(process.cwd(), 'ios/App/App.xcodeproj/project.pbxproj')
const src = readFileSync(pbx, 'utf8')
const found = src.match(/CURRENT_PROJECT_VERSION = (\d+);/)
if (!found) {
  throw new Error('prepare-ios-web: CURRENT_PROJECT_VERSION not found')
}

const current = found[1]
const requested = process.env.NOD_IOS_BUNDLE
let next
let pinned = false
if (requested === undefined || requested.trim() === '') {
  next = String(Number(current) + 1)
} else {
  const text = requested.trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `prepare-ios-web: NOD_IOS_BUNDLE must be a non-negative integer (got ${JSON.stringify(requested)})`,
    )
  }
  next = String(Number(text))
  pinned = true
}

writeFileSync(pbx, src.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${next};`))
process.stdout.write(
  `prepare-ios-web: CURRENT_PROJECT_VERSION ${current} -> ${next}${pinned ? ' (pinned by NOD_IOS_BUNDLE)' : ''}\n`,
)
