import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function pngSize(rel) {
  const buf = fs.readFileSync(path.join(root, rel))
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${rel} is not a PNG`)
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

function eq(got, want, label) {
  if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`)
}

const source = pngSize('docs/design/brand/launch-source.png')
eq(source.w, 851, 'launch-source width')
eq(source.h, 1847, 'launch-source height')

const one = pngSize('docs/design/brand/launch-851x1847.png')
eq(one.w, 851, '1x launch width')
eq(one.h, 1847, '1x launch height')

const two = pngSize('ios/App/App/Assets.xcassets/LaunchBrand.imageset/launch-brand@2x.png')
eq(two.w, 1702, '2x launch width')
eq(two.h, 3694, '2x launch height')

const three = pngSize('ios/App/App/Assets.xcassets/LaunchBrand.imageset/launch-brand@3x.png')
eq(three.w, 2553, '3x launch width')
eq(three.h, 5541, '3x launch height')

console.log('launch-raster.test.mjs: ok')
