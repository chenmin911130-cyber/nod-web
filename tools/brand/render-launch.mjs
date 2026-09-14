import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

/* Phone launch images come from the confirmed design raster (851 x 1847).
 * `sips` writes the 2x / 3x catalog entries so a 3x phone is not upscaling 1x. */
const source = path.join(root, 'docs/design/brand/launch-source.png')
if (!fs.existsSync(source)) {
  throw new Error(`missing ${source}`)
}

const oneX = path.join(root, 'docs/design/brand/launch-851x1847.png')
fs.copyFileSync(source, oneX)

const targets = [
  [path.join(root, 'ios/App/App/Assets.xcassets/LaunchBrand.imageset/launch-brand@2x.png'), 1702, 3694],
  [path.join(root, 'ios/App/App/Assets.xcassets/LaunchBrand.imageset/launch-brand@3x.png'), 2553, 5541],
]

for (const [out, w, h] of targets) {
  const res = spawnSync('sips', ['-z', String(h), String(w), source, '--out', out], { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`sips failed for ${out}: ${res.stderr || res.stdout}`)
  }
  console.log('wrote', path.relative(root, out), `${w}x${h}`)
}
console.log('wrote', path.relative(root, oneX), '851x1847')
