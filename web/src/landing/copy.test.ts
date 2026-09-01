import { COPY } from './copy'

function publicText(): string {
  return JSON.stringify(COPY)
}

const leaked = publicText().match(/stealth|pin-on-top|隐身/gi)
if (leaked) {
  throw new Error(`public landing copy must not advertise desktop stealth: ${leaked.join(', ')}`)
}
