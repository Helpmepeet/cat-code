import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../shared/hostApi.js'
import { createDirectoryPickerHandlers } from './directoryPicker.js'

test('legacy absent and null selections use recent chat while scheduled requests never consult chats', async () => {
  const defaults: (string | undefined)[] = []
  let reads = 0
  const handlers = createDirectoryPickerHandlers({
    isAuthorized: (sender: string) => sender === 'main',
    sessions: () => {
      reads++
      return [
        { appSessionId: '00000000-0000-4000-8000-000000000001', cwd: '/older', lastAttachedAt: 1, restorable: false },
        { appSessionId: '00000000-0000-4000-8000-000000000002', cwd: '/recent', lastAttachedAt: 2, restorable: false },
      ] as SessionDescriptor[]
    },
    pick: async defaultPath => { defaults.push(defaultPath); return 'opaque-native-token' },
  })
  expect(await handlers.legacy('main')).toBe('opaque-native-token')
  expect(await handlers.legacy('main', null)).toBe('opaque-native-token')
  await handlers.legacy('main', '00000000-0000-4000-8000-000000000001')
  expect(reads).toBe(3)
  expect(await handlers.scheduled('main')).toBe('opaque-native-token')
  expect(reads).toBe(3)
  expect(defaults).toEqual(['/recent', '/recent', '/older', undefined])
  for (const payload of [null, {}, [], '/authored', { activeSessionId: 'chat' }, { cwd: '/authored' }]) {
    expect(await handlers.scheduled('main', payload)).toBeNull()
  }
  expect(await handlers.scheduled('other')).toBeNull()
  expect(await handlers.legacy('other')).toBeNull()
  expect(await handlers.legacy('main', {})).toBeNull()
  expect(defaults).toHaveLength(4)
})
