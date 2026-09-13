import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs helper, no types shipped
import { renderSVG } from './srender.mjs'
// @ts-expect-error -- plain .mjs helper, no types shipped
import R from './rasterize.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

/* The design SVG is the source of truth; these PNGs are its deterministic
 * rasterisation. The launch image is declared at 851x1847 points, so the 1x
 * render is the design frame and 2x/3x are the same frame at higher density. */
const design = fs.readFileSync(path.join(root, 'docs/design/brand/launch-screen.svg'), 'utf8')

function at(svgText, scale) {
  // Restating width/height does not scale child coordinates, so wrap the design
  // frame in an outer svg that carries the target size.
  const inner = svgText.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${851 * scale}" height="${1847 * scale}">` +
    `<g transform="scale(${scale})">${inner}</g></svg>`
}

const targets = [
  ['docs/design/brand/launch-851x1847.png', 851, 1847, 4],
  ['ios/App/App/Assets.xcassets/LaunchBrand.imageset/launch-brand@2x.png', 1702, 3694, 2],
  ['ios/App/App/Assets.xcassets/LaunchBrand.imageset/launch-brand@3x.png', 2553, 5541, 1],
]

for (const [rel, w, h, ss] of targets) {
  const svg = w === 851 ? design : at(design, w / 851)
  const png = R.encodePNG(w, h, renderSVG(svg, w, h, ss))
  fs.writeFileSync(path.join(root, rel), png)
  console.log('wrote', rel, `${w}x${h}`)
}
