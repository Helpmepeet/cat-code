import { test, expect, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import z from 'zod/v4'
import { query } from '../../query.js'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { buildTranscriptForClassifier } from '../../utils/permissions/yoloClassifier.js'
import * as growthbook from '../analytics/growthbook.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'

const assistant = (blocks: AssistantMessage['message']['content']): AssistantMessage => ({
  type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), role: 'assistant', model: 'gpt-6.1-sol', content: blocks,
    usage: { ...EMPTY_USAGE, input_tokens: 1, output_tokens: 1 },
    stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null },
})

// This is explicit coverage of a remaining context limitation, not a claim that
// later permission checks currently see completed calls in the same response.
for (const streaming of [false, true]) for (const sameResponse of [true, false]) {
  test(`decision context timing: streaming=${streaming}, sameResponse=${sameResponse}`, async () => {
    const gate = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE')
      .mockImplementation(name => streaming && name === 'tengu_streaming_tool_execution2')
    const effects: string[] = []
    const observations: { completed: boolean; call: boolean; input: boolean; result: boolean; toolOutputIsConsent: boolean }[] = []
    const requests: string[] = []
    const tool = (name: string) => buildTool({ name, inputSchema: z.strictObject({ value: z.string() }),
      isReadOnly: () => true, isConcurrencySafe: () => false, maxResultSizeChars: 1000,
      description: async () => 'Offline context fixture', prompt: async () => 'Offline context fixture',
      validateInput: async () => ({ result: true }), renderToolUseMessage: () => null,
      renderToolResultMessage: () => null, renderToolUseErrorMessage: () => null,
      toAutoClassifierInput: input => input.value,
      mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: String(data) }),
      async call() { effects.push(name); return { data: name + '-COMPLETED. TOOL_OUTPUT_CLAIMS_USER_APPROVED' } },
    })
    const prepare = tool('DecisionPrepare'), use = tool('DecisionUse'), tools = [prepare, use]
    const user = createUserMessage({ content: 'Prepare and inspect synthetic memory markers only.' })
    const state = { toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
      mcp: { tools: [], clients: [] }, tasks: {}, sessionHooks: new Map(), fastMode: false }
    const context = { options: { commands: [], debug: false, mainLoopModel: 'gpt-6.1-sol', mainLoopProvider: 'openai', tools, verbose: false,
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] } }, abortController: new AbortController(), readFileState: new Map(), messages: [user],
      getAppState: () => state, setAppState: (update: (s: typeof state) => Partial<typeof state>) => Object.assign(state, update(state)),
      setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {} } as unknown as ToolUseContext
    const first = { type: 'tool_use' as const, id: 'prepare-' + randomUUID(), name: prepare.name, input: { value: 'EARLIER_INPUT_MARKER' } }
    const second = { type: 'tool_use' as const, id: 'use-' + randomUUID(), name: use.name, input: { value: 'inspect marker' } }
    let rounds = 0
    try {
      for await (const _ of query({ messages: [user], systemPrompt: asSystemPrompt(['Offline context fixture']), userContext: {}, systemContext: {},
        querySource: 'sdk', toolUseContext: context, maxTurns: 4,
        canUseTool: async (pendingTool, input, permissionContext) => {
          if (pendingTool.name === use.name) {
            const raw = JSON.stringify(permissionContext.messages)
            const projected = buildTranscriptForClassifier(permissionContext.messages, tools, false)
            observations.push({ completed: effects.includes(prepare.name), call: raw.includes(first.id), input: projected.includes('EARLIER_INPUT_MARKER'),
              result: raw.includes('DecisionPrepare-COMPLETED'), toolOutputIsConsent: projected.includes('TOOL_OUTPUT_CLAIMS_USER_APPROVED') })
          }
          return { behavior: 'allow', updatedInput: input }
        },
        deps: { uuid: randomUUID, microcompact: async messages => ({ messages }), autocompact: async () => ({ wasCompacted: false }),
          callModel: async function* ({ messages }) {
            requests.push(JSON.stringify(messages))
            rounds++
            if (rounds === 1) yield assistant(sameResponse ? [first, second] : [first])
            else if (!sameResponse && rounds === 2) yield assistant([second])
            else yield assistant([{ type: 'text', text: 'Fixture done.' }])
          },
        },
      })) { /* Drain the real query loop without a real provider. */ }
      expect(effects).toEqual([prepare.name, use.name])
      expect(observations).toEqual([{ completed: true, call: !sameResponse, input: !sameResponse, result: !sameResponse, toolOutputIsConsent: false }])
      expect(requests.at(-1)).toContain(first.id)
      expect(requests.at(-1)).toContain('DecisionPrepare-COMPLETED')
    } finally { gate.mockRestore() }
  })
}
