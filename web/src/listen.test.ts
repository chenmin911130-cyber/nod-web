import { LISTEN_SCENES, sceneLabel } from './listen'

function eq<T>(got: T, want: T) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(sceneLabel('interview'), 'Live Q&A')
eq(LISTEN_SCENES.find((s) => s.id === 'interview')?.label, 'Live Q&A')
eq(sceneLabel('meeting'), 'Meeting')
eq(sceneLabel('lecture'), 'Lecture')
