import { expect, test } from 'bun:test'
import { restorePreviewScroll } from './previewScrollRestore.js'

test('scroll restoration ignores a page hook return value', async () => {
  let source = ''
  await restorePreviewScroll({ executeJavaScript: async script => { source = script } }, { x: 12, y: 34 })
  let called: number[] | undefined
  const result = new Function('scrollTo', 'source', 'return eval(source)')((...coordinates: number[]) => {
    called = coordinates
    return new Promise(() => {})
  }, source)
  expect(called).toEqual([12, 34])
  expect(result).toBeUndefined()
})

test('an unresponsive preview frame cannot keep scroll restoration pending', async () => {
  await restorePreviewScroll({ executeJavaScript: () => new Promise(() => {}) }, { x: 0, y: 0 })
})

test.each(['throw', 'reject'] as const)('a frame that fails by %s does not fail scroll restoration', async failure => {
  await restorePreviewScroll({ executeJavaScript: () => {
    if (failure === 'throw') throw new Error('Frame unavailable')
    return Promise.reject(new Error('Frame unavailable'))
  } }, { x: 0, y: 0 })
})
