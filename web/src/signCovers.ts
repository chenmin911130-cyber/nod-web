export type SignCoverId = 'listen' | 'understand' | 'remember'

export type SignCover = {
  id: SignCoverId
  src: string
  title: string
  line: string
  alt: string
}

export const SIGN_COVERS: SignCover[] = [
  {
    id: 'listen',
    src: '/covers/listen.png',
    title: 'Listen.',
    line: 'Live captions during the meeting.',
    alt: 'Nodpilot showing a live meeting transcript on iPhone.',
  },
  {
    id: 'understand',
    src: '/covers/understand.png',
    title: 'Understand.',
    line: 'Translate every conversation as it happens.',
    alt: 'Nodpilot translating a conversation live on iPhone.',
  },
  {
    id: 'remember',
    src: '/covers/remember.png',
    title: 'Remember.',
    line: "Don't just record. Keep what matters.",
    alt: 'Nodpilot turning a lecture into notes on iPhone.',
  },
]

export function signCoverById(id: SignCoverId): SignCover {
  return SIGN_COVERS.find((item) => item.id === id) ?? SIGN_COVERS[0]
}

export function nextSignCover(id: SignCoverId): SignCoverId {
  const index = SIGN_COVERS.findIndex((item) => item.id === id)
  return SIGN_COVERS[(index + 1 + SIGN_COVERS.length) % SIGN_COVERS.length].id
}

export function prevSignCover(id: SignCoverId): SignCoverId {
  const index = SIGN_COVERS.findIndex((item) => item.id === id)
  return SIGN_COVERS[(index - 1 + SIGN_COVERS.length) % SIGN_COVERS.length].id
}
