import { ellipsize, pdfTitleLiteral, wrap } from './pdf'

function ctxOf(charWidth: number): CanvasRenderingContext2D {
  return { measureText: (s: string) => ({ width: s.length * charWidth }) } as unknown as CanvasRenderingContext2D
}

function eq(got: string[], want: string[], label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// Latin text must wrap at spaces, never mid-word. (Old char-loop produced
// "hi there wo" / "rld" for maxWidth 110.)
eq(wrap(ctxOf(10), 'hi there world', 110), ['hi there', 'world'], 'latin wraps at word boundary')
eq(wrap(ctxOf(10), 'hi there world', 140), ['hi there world'], 'latin fits on one line')
eq(wrap(ctxOf(10), 'hello', 100), ['hello'], 'short word untouched')

// CJK still packs per-glyph (break between glyphs is fine).
eq(wrap(ctxOf(10), '你好世界', 30), ['你好世', '界'], 'cjk per-glyph wrap')

// A single word wider than the line falls back to a char-level break.
// It must not crash, and re-joining the lines must recover the exact word.
const overWide = wrap(ctxOf(10), 'supercalifragilistic', 40)
if (overWide.join('') !== 'supercalifragilistic') {
  throw new Error(`over-wide word reconstructed, got ${JSON.stringify(overWide)}`)
}

// Titles: ASCII stays a plain literal; non-ASCII becomes a UTF-16BE hex string.
if (pdfTitleLiteral('Nodpilot') !== '(Nodpilot)') throw new Error('ascii title literal')
if (pdfTitleLiteral('') !== '(Nodpilot)') throw new Error('empty title falls back to brand')
if (pdfTitleLiteral('会议') !== '<FEFF4F1A8BAE>') throw new Error(`utf16be title, got ${pdfTitleLiteral('会议')}`)
if (!pdfTitleLiteral('capacità').startsWith('<FEFF') || !pdfTitleLiteral('capacità').includes('00E0')) {
  throw new Error(`non-ascii title is utf16be, got ${pdfTitleLiteral('capacità')}`)
}

// ellipsize: fits -> unchanged; Latin pulls back word-by-word; CJK glyph-by-glyph.
if (ellipsize(ctxOf(10), 'hello world', 110) !== 'hello world') throw new Error('fits unchanged')
if (ellipsize(ctxOf(10), 'hello world', 80) !== 'hello…') throw new Error(`latin word ellipsis, got ${ellipsize(ctxOf(10), 'hello world', 80)}`)
if (ellipsize(ctxOf(10), '你好世界', 30) !== '你好…') throw new Error(`cjk glyph ellipsis, got ${ellipsize(ctxOf(10), '你好世界', 30)}`)
