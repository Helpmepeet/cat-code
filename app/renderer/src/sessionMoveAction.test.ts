import { expect, test } from 'bun:test'
import type { CatCodeBridge } from '../../shared/protocol.js'
import { requestSessionMove } from './sessionMoveAction.js'

test('cancelling the project picker leaves the Chat untouched', async () => {
  const calls: Array<{ appSessionId: string; token: string | null }> = []
  const bridge = {
    pickDirectory: async () => null,
    moveSession: async (appSessionId: string, token: string | null) => {
      calls.push({ appSessionId, token })
      return { ok: false as const, error: { code: 'session_unreachable' as const, message: 'unexpected move' } }
    },
  } satisfies Pick<CatCodeBridge, 'pickDirectory' | 'moveSession'>
  expect(await requestSessionMove(bridge, 'chat-id', 'move-to-project')).toBeNull()
  expect(calls).toEqual([])
  await requestSessionMove(bridge, 'chat-id', 'move-back')
  expect(calls).toEqual([{ appSessionId: 'chat-id', token: null }])
})
