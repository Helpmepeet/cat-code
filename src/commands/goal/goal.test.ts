import { describe, expect, test } from 'bun:test'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { call } from './goal.js'

describe('/goal command', () => {
  test('rejects setting a new goal while a turn is running', async () => {
    let result: string | undefined
    const onDone: LocalJSXCommandOnDone = value => {
      result = value
    }

    await call(
      onDone,
      {
        isQueryActive: true,
        getAppState: () => ({ threadGoal: null }),
      } as Parameters<typeof call>[1],
      'finish the task',
    )

    expect(result).toBe(
      'Cannot set a new goal while a turn is running. Stop or wait first.',
    )
  })
})
