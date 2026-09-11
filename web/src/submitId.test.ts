import { newSubmitId } from './submitId'

// #182: the server's search gate dedupes on this id, so it has to be present,
// safe, and different for every submit action.
const ids = new Set<string>()
for (let i = 0; i < 500; i++) {
  const id = newSubmitId()
  if (!id) throw new Error('a submit id must never be empty')
  if (id.length > 56) throw new Error(`a submit id must stay short enough to key on: ${id}`)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`a submit id must survive the server's sanitiser: ${id}`)
  if (ids.has(id)) throw new Error(`two submit actions shared an id: ${id}`)
  ids.add(id)
}
