import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConnectionChip, mapConnectionToChip } from './ConnectionChip.js'
import type { ConnectionSnapshot } from './connectionState.js'

function snap(status: ConnectionSnapshot['status']): ConnectionSnapshot {
  return { status, inputEnabled: status === 'ready' }
}

test('a healthy (ready) session maps to null — the chip is hidden', () => {
  expect(mapConnectionToChip(snap('ready'))).toBeNull()
})

test('spawn states show a pulsing "connecting"/"starting" with no retry', () => {
  expect(mapConnectionToChip(snap('connecting'))).toEqual({
    visual: 'reconnecting',
    label: 'connecting',
    canRetry: false,
  })
  expect(mapConnectionToChip(snap('starting'))).toEqual({
    visual: 'reconnecting',
    label: 'starting',
    canRetry: false,
  })
})

test('terminal states are restartable and honestly labelled', () => {
  expect(mapConnectionToChip(snap('disconnected'))).toEqual({
    visual: 'disconnected',
    label: 'disconnected',
    canRetry: true,
  })
  expect(mapConnectionToChip(snap('dead'))).toEqual({
    visual: 'reconnect_failed',
    label: 'dead',
    canRetry: true,
  })
  expect(mapConnectionToChip(snap('failed'))?.canRetry).toBe(true)
  expect(mapConnectionToChip(snap('exited'))?.label).toBe('exited')
})

test('the chip is hidden for a ready session (quiet-until-wrong)', () => {
  expect(
    renderToStaticMarkup(<ConnectionChip connection={snap('ready')} />),
  ).toBe('')
})

test('a dead session with an onRetry handler surfaces a restart affordance', () => {
  const html = renderToStaticMarkup(
    <ConnectionChip connection={snap('dead')} onRetry={() => {}} />,
  )
  expect(html).toContain('dead')
  expect(html).toContain('retry')
  expect(html).toContain('text-tone-danger')
})

test('without an onRetry handler the chip still shows state but offers no retry', () => {
  const html = renderToStaticMarkup(
    <ConnectionChip connection={snap('dead')} />,
  )
  expect(html).toContain('dead')
  expect(html).not.toContain('retry')
})
