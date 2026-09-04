import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
const next = Number(found[1]) + 1
writeFileSync(pbx, src.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${next};`))
process.stdout.write(`prepare-ios-web: CURRENT_PROJECT_VERSION ${found[1]} -> ${next}\n`)
