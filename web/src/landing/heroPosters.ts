import type { DemoMode } from './HeroDemo'

export type HeroPosterId = 'meeting' | 'lecture' | 'translate'

export type HeroPoster = {
  id: HeroPosterId
  src: string
  srcSet: string
  sizes: string
  demo: DemoMode
}

export const HERO_POSTER_SIZES = '(max-width: 768px) calc(100vw - 32px), 1180px'

export const HERO_POSTERS: HeroPoster[] = [
  poster('meeting', 'meeting'),
  poster('lecture', 'meeting'),
  poster('translate', 'translate'),
]

function poster(id: HeroPosterId, demo: DemoMode): HeroPoster {
  const base = `/landing/hero-${id}`
  return {
    id,
    src: `${base}.webp`,
    srcSet: `${base}-768.webp 768w, ${base}-1280.webp 1280w, ${base}.webp 1536w`,
    sizes: HERO_POSTER_SIZES,
    demo,
  }
}

export function heroPosterById(id: HeroPosterId): HeroPoster {
  return HERO_POSTERS.find((item) => item.id === id) ?? HERO_POSTERS[0]
}

export function nextHeroPoster(id: HeroPosterId): HeroPosterId {
  const index = HERO_POSTERS.findIndex((item) => item.id === id)
  return HERO_POSTERS[(index + 1) % HERO_POSTERS.length].id
}
