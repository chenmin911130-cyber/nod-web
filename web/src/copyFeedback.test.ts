import {
  COPY_FAIL_MS,
  COPY_OK_LABEL,
  COPY_OK_MS,
  copyButtonLabel,
  copyFlashText,
  copyHoldMs,
  copySnapshot,
  isAbortError,
  shareCopyToFlash,
  shareOrCopy,
} from './copyFeedback'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(copyHoldMs('ok'), COPY_OK_MS, 'success holds 1.5s')
eq(copyHoldMs('fail'), COPY_FAIL_MS, 'fail holds 4s')
eq(copyHoldMs('empty'), COPY_FAIL_MS, 'empty holds as fail')
eq(copyFlashText('ok'), COPY_OK_LABEL, 'ok label')
eq(copyFlashText('fail'), "Couldn't copy. Try again.", 'fail label')
eq(copyFlashText('empty'), 'Nothing to copy.', 'empty label')
eq(copyButtonLabel('Copy', 'ok', true), COPY_OK_LABEL, 'active success replaces idle')
eq(copyButtonLabel('Copy', 'fail', true), "Couldn't copy. Try again.", 'active fail replaces idle')
eq(copyButtonLabel('Copy', 'ok', false), 'Copy', 'other entry keeps idle')
eq(isAbortError({ name: 'AbortError' }), true, 'AbortError by name')
eq(isAbortError(new Error('share failed')), false, 'plain error is not abort')

eq(await copySnapshot('   ', async () => true), 'empty', 'blank text is empty')
eq(await copySnapshot('hello', async () => true), 'ok', 'clipboard ok')
eq(await copySnapshot('hello', async () => false), 'fail', 'clipboard fail')

eq(await shareOrCopy('  ', { copy: async () => true }), 'empty', 'share empty')
eq(
  await shareOrCopy('notes', {
    share: async () => undefined,
    copy: async () => true,
  }),
  'shared',
  'successful share is not a copy',
)

let copied = false
eq(
  await shareOrCopy('notes', {
    share: async () => {
      throw Object.assign(new Error('cancel'), { name: 'AbortError' })
    },
    copy: async () => {
      copied = true
      return true
    },
  }),
  'aborted',
  'user cancel is abort',
)
eq(copied, false, 'AbortError must not copy')

eq(
  await shareOrCopy('notes', {
    share: async () => {
      throw new Error('no share sheet')
    },
    copy: async () => true,
  }),
  'copied',
  'share failure falls back to copy',
)

eq(
  await shareOrCopy('notes', {
    share: undefined,
    copy: async () => true,
  }),
  'copied',
  'no share API copies',
)

eq(
  await shareOrCopy('notes', {
    share: async () => {
      throw new Error('no share sheet')
    },
    copy: async () => false,
  }),
  'fail',
  'fallback copy failure is fail',
)

eq(shareCopyToFlash('shared'), null, 'share success has no Copied flash')
eq(shareCopyToFlash('aborted'), null, 'abort has no Copied flash')
eq(shareCopyToFlash('copied'), 'ok', 'fallback copy flashes ok')
eq(shareCopyToFlash('fail'), 'fail', 'fallback fail flashes fail')

console.log('copyFeedback.test.ts ok')
