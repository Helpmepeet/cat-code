import { describe, expect, mock, test } from 'bun:test'

import { call } from './agent.js'

describe('/agent command', () => {
  test('enters Agent Mode and forwards inline args as the next normal prompt', async () => {
    const enterAgentModeSession = mock(async () => {})
    const startAgentModeRun = mock(async (_objective: string) => {})
    const onDone = mock(() => {})

    await call(
      onDone,
      {
        enterAgentModeSession,
        startAgentModeRun,
      } as never,
      'clean up the agent mode remnants',
    )

    expect(enterAgentModeSession).toHaveBeenCalledTimes(1)
    expect(startAgentModeRun).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith('Started a fresh Agent mode session.', {
      display: 'system',
      nextInput: 'clean up the agent mode remnants',
      submitNextInput: true,
    })
  })

  test('reports when Agent Mode is unavailable', async () => {
    const onDone = mock(() => {})

    await call(onDone, {} as never, '')

    expect(onDone).toHaveBeenCalledWith(
      'Agent mode is not available in this session.',
    )
  })
})
