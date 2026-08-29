import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dist = resolve(process.cwd(), 'web/dist')
const indexPath = resolve(dist, 'index.html')

const html = readFileSync(indexPath, 'utf8')
const boot = `<script>
(function () {
  try {
    var q = new URLSearchParams(location.search)
    if (!q.get('view')) {
      location.replace('./app.html' + location.search + location.hash)
    }
  } catch (e) {}
})()
</script>`

if (html.includes('location.replace(\'./app.html\'')) {
  process.stdout.write('prepare-ios-web: native boot already present\n')
  process.exit(0)
}

const next = html.includes('</head>')
  ? html.replace('</head>', `${boot}\n</head>`)
  : `${boot}\n${html}`

writeFileSync(indexPath, next)
process.stdout.write('prepare-ios-web: native app boots into app.html\n')
