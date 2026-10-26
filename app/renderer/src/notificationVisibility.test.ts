import { expect, test } from 'bun:test'
import { observeNotificationVisibility } from './notificationVisibility.js'
import type { NotificationVisibility } from '../../shared/notificationVisibility.js'

test('reports page visibility independently of keyboard focus and cleans up the document listener', () => {
  const target = new EventTarget()
  const doc = Object.assign(target, { visibilityState: 'visible' as DocumentVisibilityState })
  const reports: NotificationVisibility[] = []
  const stop = observeNotificationVisibility('shown', doc, value => { reports.push(value) })
  doc.dispatchEvent(new Event('blur'))
  expect(reports).toEqual([{ sessionId: 'shown', visible: true }])
  doc.visibilityState = 'hidden'
  doc.dispatchEvent(new Event('visibilitychange'))
  doc.visibilityState = 'visible'
  doc.dispatchEvent(new Event('visibilitychange'))
  expect(reports).toEqual([
    { sessionId: 'shown', visible: true }, { sessionId: 'shown', visible: false }, { sessionId: 'shown', visible: true },
  ])
  stop()
  doc.dispatchEvent(new Event('visibilitychange'))
  expect(reports).toHaveLength(3)
})

test('retries rate-guard rejection with current visibility and cancels stale pane retries', async () => {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
  const reports: NotificationVisibility[] = []
  let reject = true
  const stop = observeNotificationVisibility('previous', doc, value => {
    if (reject) throw new Error('rate limited')
    reports.push(value)
  })
  doc.visibilityState = 'hidden'
  reject = false
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(reports).toEqual([{ sessionId: 'previous', visible: false }])
  stop()
  reject = true
  const cancel = observeNotificationVisibility('stale', doc, () => { throw new Error('rate limited') })
  cancel()
  const next = observeNotificationVisibility(null, doc, value => { reports.push(value) })
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(reports.at(-1)).toEqual({ sessionId: null, visible: false })
  next()
})
