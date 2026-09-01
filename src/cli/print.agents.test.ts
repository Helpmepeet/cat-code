import { describe, expect, test } from 'bun:test'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { handleInitializeRequest } from './print.js'

// The SDK initialize path used to merge agents with parseAgentsFromJson and
// keep whatever survived, so a client that sent a bad definition got a normal
// init response and a session with the agent missing. It must refuse instead.

type InitializeArgs = Parameters<typeof handleInitializeRequest>

function harness(requestAgents: unknown) {
  const enqueued: { type: string; response?: Record<string, unknown> }[] = []
  const agents: AgentDefinition[] = []

  const request = {
    subtype: 'initialize',
    agents: requestAgents,
  } as unknown as InitializeArgs[0]

  const output = {
    enqueue: (message: { type: string; response?: Record<string, unknown> }) => {
      enqueued.push(message)
    },
  } as unknown as InitializeArgs[3]

  const structuredIO = {
    getPendingPermissionRequests: () => [],
  } as unknown as InitializeArgs[6]

  const getAppState = (() => ({})) as unknown as InitializeArgs[10]

  const run = () =>
    handleInitializeRequest(
      request,
      'req-1',
      false,
      output,
      [],
      [],
      structuredIO,
      false,
      { systemPrompt: undefined, appendSystemPrompt: undefined },
      agents,
      getAppState,
    )

  return { run, enqueued, agents }
}

describe('handleInitializeRequest agents payload', () => {
  test('an invalid definition is refused with an error response', async () => {
    const { run, enqueued, agents } = harness({
      reviewer: { description: 'Reviews code' },
    })

    // Returning without throwing is itself the proof that it stopped here:
    // everything past the agents block reaches account lookup, which needs
    // live credentials this suite must not use.
    await run()

    expect(agents).toEqual([])
    expect(enqueued.length).toBe(1)
    expect(enqueued[0]?.type).toBe('control_response')
    expect(enqueued[0]?.response?.subtype).toBe('error')
    expect(String(enqueued[0]?.response?.error)).toContain(
      'Invalid agent configuration',
    )
    expect(String(enqueued[0]?.response?.error)).toContain('reviewer.prompt')
    expect(String(enqueued[0]?.response?.error)).not.toContain('—')
  })

  test('a valid definition is merged and not refused', async () => {
    const { run, enqueued, agents } = harness({
      reviewer: { description: 'Reviews code', prompt: 'You review code.' },
    })

    // The agents merge is the first thing initialization does; everything
    // after it reaches account lookup, which needs live credentials this
    // suite must not use. Let that part fail and assert on the merge.
    await run().catch(() => {})

    expect(agents.map(agent => agent.agentType)).toEqual(['reviewer'])
    expect(
      enqueued.filter(message => message.response?.subtype === 'error'),
    ).toEqual([])
  })
})
