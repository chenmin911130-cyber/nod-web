import { HERO_POSTER_SIZES, HERO_POSTERS, heroPosterById, nextHeroPoster } from './heroPosters'

function eq<T>(got: T, want: T) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(HERO_POSTERS.map((item) => item.id), ['meeting', 'lecture', 'translate'])
eq(
  HERO_POSTERS.map((item) => item.src),
  ['/landing/hero-meeting.webp', '/landing/hero-lecture.webp', '/landing/hero-translate.webp'],
)
for (const item of HERO_POSTERS) {
  if (!item.src.endsWith('.webp')) {
    throw new Error(`hero src must be webp: ${item.src}`)
  }
  if (item.src.includes('.png')) {
    throw new Error(`hero src must not point at png: ${item.src}`)
  }
  eq(item.sizes, HERO_POSTER_SIZES)
  eq(
    item.srcSet,
    `/landing/hero-${item.id}-768.webp 768w, /landing/hero-${item.id}-1280.webp 1280w, /landing/hero-${item.id}.webp 1536w`,
  )
}
eq(nextHeroPoster('meeting'), 'lecture')
eq(nextHeroPoster('lecture'), 'translate')
eq(nextHeroPoster('translate'), 'meeting')
eq(heroPosterById('translate').demo, 'translate')
eq(heroPosterById('lecture').demo, 'meeting')
