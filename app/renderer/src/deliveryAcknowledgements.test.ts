import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('subscription receipt is emitted by the renderer callback before projection', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const callback = source.indexOf('const unsubscribe = bridge.subscribe(frames => {')
  const subscriptionAck = source.indexOf("'renderer.subscription.received'", callback)
  const projection = source.indexOf('applyPreviewHandover(', callback)
  expect(callback).toBeGreaterThan(-1)
  expect(subscriptionAck).toBeGreaterThan(callback)
  expect(subscriptionAck).toBeLessThan(projection)
})

test('applied and committed evidence is post-commit rather than dispatch-return evidence', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const callback = source.indexOf('const unsubscribe = bridge.subscribe(frames => {')
  const appliedAck = source.indexOf("'renderer.state.applied'")
  const committedAck = source.indexOf("'renderer.ui.committed'")
  const postCommitEffect = source.lastIndexOf('useEffect(() => {', appliedAck)
  expect(postCommitEffect).toBeGreaterThan(-1)
  expect(postCommitEffect).toBeLessThan(callback)
  expect(appliedAck).toBeGreaterThan(postCommitEffect)
  expect(committedAck).toBeGreaterThan(postCommitEffect)
})
