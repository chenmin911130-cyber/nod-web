import fs from 'node:fs'
import path from 'node:path'

/* ---------------------------------------------------------------------------
 * Brand launch composition -- single source of truth for the phone + watch
 * splash screens.
 *
 * Geometry is authored in the confirmed design frame (851 x 1847) and every
 * emitted SVG puts that frame at its natural origin, so rasterising or cropping
 * it never shifts anything.
 *
 * Run: node tools/brand/compose.mjs [outDir]
 * ------------------------------------------------------------------------- */
const DW = 851
const DH = 1847
const PAD = 1847
const PADX = (PAD - DW) / 2 // 498
const CX = 425.5 // composition centre line
const CY = 799.5
const MARK_INK_H = 160
const GAP = 45.72 // measured mark-ink-right (178+131.282) -> wordmark-ink-left (355) in the confirmed design
const MB = { x0: 21.24, x1: 85.24, y0: 14.24, y1: 92.24 } // logo.svg ink bbox (viewBox units)
const WORD = [355, 673.5] // wordmark ink x-range in the design frame
const F4 = '#f4f8fc'
const CYAN = '#00d2ff'
const r = (v) => Math.round(v * 1000) / 1000
const n = (v) => Number(v.toFixed(3))

/* Wordmark metrics measured off the confirmed design: baseline 822, x-height 778,
 * ascender 762, descender 838. The word reads n, o, d, p, i, l, o, t. An earlier
 * revision of this file dropped the second "o" and drew the t where it belongs. */
const G = {
  n: { x: 356, stem: 9.5, apex: 778, base: 822, archR: 19.5 },
  o: { cx: 424.5, cy: 800.5, ro: 22.5, ri: 5.5 },
  d: { stem: 489, sw: 9.5, top: 762, base: 822, cx: 475.5, cy: 800.5, ro: 22.5, ri: 5.5 },
  p: { stem: 508, sw: 9.5, cx: 529, cy: 800.5, ro: 22.5, ri: 6.5, desc: 838 },
  i: { x: 559, w: 10, top: 778, base: 822, dotCy: 768, dotR: 5.5 },
  l: { x: 580, w: 10, top: 762, base: 822 },
  o2: { cx: 619.5, cy: 800.5, ro: 22.5, ri: 5.5 },
  t: { stem: 653.75, sw: 10, top: 766, base: 822, cbX: 646, cbW: 27.5, cbY: 778, cbH: 9.5 },
}

const ring = (cx, cy, ro, ri) =>
  `<path fill-rule="evenodd" d="M${n(cx)} ${n(cy - ro)} A${ro} ${ro} 0 1 1 ${n(cx)} ${n(cy + ro)} ` +
  `A${ro} ${ro} 0 1 1 ${n(cx)} ${n(cy - ro)} Z ` +
  `M${n(cx)} ${n(cy - ri)} A${ri} ${ri} 0 1 0 ${n(cx)} ${n(cy + ri)} ` +
  `A${ri} ${ri} 0 1 0 ${n(cx)} ${n(cy - ri)} Z"/>`

const MARK_PATHS =
  `<path d="M26 88 V32 A13 13 0 0 1 52 32 L78 58" fill="none" stroke="${F4}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="M58 38 Q66 29 81 34 V60" fill="none" stroke="${F4}" stroke-width="9" stroke-linecap="round"/>` +
  `<circle cx="81" cy="70" r="4.5" fill="${CYAN}"/>`

function markSVG() {
  const mw = MB.x1 - MB.x0
  const mh = MB.y1 - MB.y0
  const s = MARK_INK_H / mh
  const MW = mw * s
  const total = WORD[1] - WORD[0] + GAP + MW
  const left = CX - total / 2
  const x = left - MB.x0 * s
  const y = CY - MARK_INK_H / 2 - MB.y0 * s
  return {
    s,
    wordDX: left + MW + GAP - WORD[0],
    svg: `<g transform="translate(${r(x)} ${r(y)}) scale(${r(s)})">${MARK_PATHS}</g>`,
  }
}

function wordSVG(dx) {
  const g = G
  const P = []
  // n -- one arch whose apex is the x-height (outer r 19.5 about y 797.5) with its
  // inward offset (r 9.5) as the counter. Both arcs span exactly twice their radius,
  // so no renderer has to scale one up: an under-sized radius would be scaled and
  // would push the counter above the outer arch.
  const nr = g.n.archR
  const nx = g.n.x
  const nw = g.n.stem
  const ncy = g.n.apex + nr
  P.push(
    `<path fill-rule="evenodd" d="M${nx} ${g.n.base} V${ncy} ` +
      `A${nr} ${nr} 0 0 1 ${n(nx + 2 * nr)} ${ncy} V${g.n.base} H${n(nx + 2 * nr - nw)} V${ncy} ` +
      `A${n(nr - nw)} ${n(nr - nw)} 0 0 0 ${n(nx + nw)} ${ncy} V${g.n.base} Z"/>`,
  )
  P.push(ring(g.o.cx, g.o.cy, g.o.ro, g.o.ri))
  P.push(`<rect x="${g.d.stem}" y="${g.d.top}" width="${g.d.sw}" height="${g.d.base - g.d.top}"/>`)
  P.push(ring(g.d.cx, g.d.cy, g.d.ro, g.d.ri))
  P.push(ring(g.p.cx, g.p.cy, g.p.ro, g.p.ri))
  P.push(
    `<rect x="${g.p.stem}" y="${n(g.p.cy - g.p.ro)}" width="${g.p.sw}" height="${n(g.p.desc - (g.p.cy - g.p.ro))}"/>`,
  )
  P.push(`<rect x="${g.i.x}" y="${g.i.top}" width="${g.i.w}" height="${g.i.base - g.i.top}"/>`)
  P.push(`<circle cx="${n(g.i.x + g.i.w / 2)}" cy="${g.i.dotCy}" r="${g.i.dotR}"/>`)
  P.push(`<rect x="${g.l.x}" y="${g.l.top}" width="${g.l.w}" height="${g.l.base - g.l.top}"/>`)
  P.push(ring(g.o2.cx, g.o2.cy, g.o2.ro, g.o2.ri))
  // t -- stem with a rightward baseline tail; the crossbar is its own rounded rect
  const t = g.t
  const ax = n(t.stem + t.sw)
  const R2 = n(t.sw / 2)
  const ry = n(t.base - R2)
  P.push(
    `<path d="M${t.stem} ${t.top} h${t.sw} V${ry} A${R2} ${R2} 0 0 0 ${ax} ${n(t.base)} H${n(t.stem + t.sw / 2)} V${ry} Z"/>`,
  )
  P.push(`<rect x="${t.cbX}" y="${t.cbY}" width="${t.cbW}" height="${t.cbH}"/>`)
  return `<g transform="translate(${r(dx)} 0)" fill="${F4}">${P.join('')}</g>`
}

const BARS = [11, 17, 27, 17, 11]
const BAR_W = 13
const BAR_CY = 1541.5
function waveSVG() {
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += `<rect x="${381 + i * 19}" y="${r(BAR_CY - BARS[i])}" width="${BAR_W}" height="${BARS[i] * 2}" rx="6.5"/>`
  }
  return `<g fill="${CYAN}">${s}</g>`
}

const M = markSVG()
const raster = `<rect x="0" y="0" width="${DW}" height="${DH}" fill="#000000"/>${M.svg}${wordSVG(M.wordDX)}${waveSVG()}`

const OUT = process.argv[2] || 'docs/design/brand'
const w = (name, content) => fs.writeFileSync(path.join(OUT, name), content)

w(
  'launch-screen.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}" viewBox="0 0 ${DW} ${DH}">${raster}</svg>`,
)
const mw = MB.x1 - MB.x0
const mh = MB.y1 - MB.y0
const sc = MARK_INK_H / mh
const mkW = mw * sc
w(
  'mark.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="${r(mkW)}" height="${MARK_INK_H}" viewBox="0 0 ${r(mkW)} ${MARK_INK_H}">` +
    `<g transform="translate(${r(-MB.x0 * sc)} ${r(-MB.y0 * sc)}) scale(${r(sc)})">${MARK_PATHS}</g></svg>`,
)

// The viewBox crops to the design's wordmark ink box so the asset is exactly 321 x 76 pt.
w(
  'wordmark.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WORD[1] - WORD[0]}" height="76" ` +
    `viewBox="${WORD[0]} 762 ${WORD[1] - WORD[0]} 76">${wordSVG(M.wordDX)}</svg>`,
)

console.log(JSON.stringify({ markScale: r(sc), markW: r(mkW), markH: MARK_INK_H, wordDX: r(M.wordDX), out: OUT }))
