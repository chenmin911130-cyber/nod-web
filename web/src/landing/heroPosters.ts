import type { DemoMode } from './HeroDemo'

export type HeroPosterId = 'meeting' | 'lecture' | 'translate'

export type HeroPoster = {
  id: HeroPosterId
  src: string
  demo: DemoMode
}

export const HERO_POSTERS: HeroPoster[] = [
  { id: 'meeting', src: '/landing/hero-meeting.png', demo: 'meeting' },
  { id: 'lecture', src: '/landing/hero-lecture.png', demo: 'meeting' },
  { id: 'translate', src: '/landing/hero-translate.png', demo: 'translate' },
]

export function heroPosterById(id: HeroPosterId): HeroPoster {
  return HERO_POSTERS.find((item) => item.id === id) ?? HERO_POSTERS[0]
}

export function nextHeroPoster(id: HeroPosterId): HeroPosterId {
  const index = HERO_POSTERS.findIndex((item) => item.id === id)
  return HERO_POSTERS[(index + 1) % HERO_POSTERS.length].id
}
