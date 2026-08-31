import { writeFileSync } from 'node:fs'
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
    <title>Nod</title>
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
