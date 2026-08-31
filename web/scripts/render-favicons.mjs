import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const svg = readFileSync(join(root, 'favicon.svg'))

for (const size of [16, 32, 48, 96, 180, 192, 512]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  const name = size === 180 ? 'apple-touch-icon.png' : `favicon-${size}.png`
  writeFileSync(join(root, name), png)
  console.log(name, png.length)
}
