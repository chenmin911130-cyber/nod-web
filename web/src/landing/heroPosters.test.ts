import { HERO_POSTERS, heroPosterById, nextHeroPoster } from './heroPosters'

function eq<T>(got: T, want: T) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(HERO_POSTERS.map((item) => item.id), ['meeting', 'lecture', 'translate'])
eq(
  HERO_POSTERS.map((item) => item.src),
  ['/landing/hero-meeting.png', '/landing/hero-lecture.png', '/landing/hero-translate.png'],
)
eq(nextHeroPoster('meeting'), 'lecture')
eq(nextHeroPoster('lecture'), 'translate')
eq(nextHeroPoster('translate'), 'meeting')
eq(heroPosterById('translate').demo, 'translate')
eq(heroPosterById('lecture').demo, 'meeting')
