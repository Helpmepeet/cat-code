import { describe, expect, test } from 'bun:test'
import { CLAUDE_CLI_TOOL_NAME } from '../tools/ClaudeCliTool/constants.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { ASK_ORCHESTRATOR_TOOL_NAME } from '../tools/AskOrchestratorTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import {
  getWorkerCapabilityPromptLine,
  resolveWorkerCapabilities,
} from './agentCapabilities.js'

describe('resolveWorkerCapabilities', () => {
  test('reports every capability false for an empty resolved pool', () => {
    expect(resolveWorkerCapabilities([])).toEqual({
      mayDelegateExternally: false,
      mayDelegateInternally: false,
      canAskOrchestrator: false,
      canSendMessage: false,
    })
  })

  test('flags mayDelegateExternally only when ClaudeCli is in the resolved pool', () => {
    expect(
      resolveWorkerCapabilities(['Read', CLAUDE_CLI_TOOL_NAME]).mayDelegateExternally,
    ).toBe(true)
    expect(resolveWorkerCapabilities(['Read']).mayDelegateExternally).toBe(
      false,
    )
  })

  test('flags mayDelegateInternally only when Agent is in the resolved pool', () => {
    expect(
      resolveWorkerCapabilities(['Read', AGENT_TOOL_NAME]).mayDelegateInternally,
    ).toBe(true)
    expect(resolveWorkerCapabilities(['Read']).mayDelegateInternally).toBe(
      false,
    )
  })

  test('flags the two escalation channels independently', () => {
    const both = resolveWorkerCapabilities([
      ASK_ORCHESTRATOR_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ])
    expect(both.canAskOrchestrator).toBe(true)
    expect(both.canSendMessage).toBe(true)

    const neither = resolveWorkerCapabilities(['Read'])
    expect(neither.canAskOrchestrator).toBe(false)
    expect(neither.canSendMessage).toBe(false)
  })

  test('accepts a Set the same as any other iterable', () => {
    const names = new Set(['Read', CLAUDE_CLI_TOOL_NAME])
    expect(resolveWorkerCapabilities(names).mayDelegateExternally).toBe(true)
  })
})

describe('getWorkerCapabilityPromptLine', () => {
  // The 2026-09-06 case: a general-purpose worker whose pool carries neither
  // delegation tool. It was told nothing, searched for Agent, and fell back to
  // launching `cat-code -p` through Bash — so the denial has to cover the
  // shell route, not just the missing tool.
  test('denies delegation, including through a shell, when neither tool is present', () => {
    const line = getWorkerCapabilityPromptLine(['Read', 'Bash'])

    expect(line).toContain('you have no tool that starts another agent')
    expect(line).toContain('MUST NOT launch one through a shell')
    expect(line).not.toContain('you may start a subagent')
  })

  test('names each delegation tool the worker was actually granted', () => {
    expect(getWorkerCapabilityPromptLine(['Read', AGENT_TOOL_NAME])).toContain(
      `you may start a subagent with ${AGENT_TOOL_NAME}`,
    )

    const externalOnly = getWorkerCapabilityPromptLine([
      'Read',
      CLAUDE_CLI_TOOL_NAME,
    ])
    expect(externalOnly).toContain(
      `you may run ${CLAUDE_CLI_TOOL_NAME} for a read-only advisory pass`,
    )
    expect(externalOnly).not.toContain(`start a subagent with ${AGENT_TOOL_NAME}`)
    expect(externalOnly).toContain('the assigned work stays yours to finish')
  })

  // §9 of the report: a foreground worker carries SendMessage and a background
  // one does not, and neither was told which it had. SendMessage routes down
  // and sideways only (SendMessageTool's no-recipient fall-through), so the
  // line must never offer it as a way back to the spawner.
  test('describes SendMessage as sideways-only, and only when the worker has it', () => {
    const foreground = getWorkerCapabilityPromptLine([
      ASK_ORCHESTRATOR_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ])
    expect(foreground).toContain(
      `${SEND_MESSAGE_TOOL_NAME} reaches running workers and teammates, never whoever spawned you.`,
    )

    const background = getWorkerCapabilityPromptLine([
      ASK_ORCHESTRATOR_TOOL_NAME,
    ])
    expect(background).not.toContain(SEND_MESSAGE_TOOL_NAME)
  })

  test('routes escalation through ask_orchestrator only when it is in the pool', () => {
    const withTool = getWorkerCapabilityPromptLine([ASK_ORCHESTRATOR_TOOL_NAME])
    expect(withTool).toContain(
      `call ${ASK_ORCHESTRATOR_TOOL_NAME} with the exact question: it ends your run and hands the question over`,
    )
    // runAgent ends the loop on the call now. Asking the worker to stop as
    // well is the instruction the run contradicts, and the volunteered stop
    // is what never happened on 2026-09-06.
    expect(withTool).not.toContain('then stop your turn')

    const withoutTool = getWorkerCapabilityPromptLine(['Read'])
    expect(withoutTool).not.toContain(ASK_ORCHESTRATOR_TOOL_NAME)
    expect(withoutTool).toContain(
      'If you are blocked, stop your turn and return a blocked result naming the exact question.',
    )
  })

  test('stays one line, since every spawn pays for it', () => {
    const widest = getWorkerCapabilityPromptLine([
      AGENT_TOOL_NAME,
      CLAUDE_CLI_TOOL_NAME,
      ASK_ORCHESTRATOR_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ])

    expect(widest).not.toContain('\n')
    expect(widest.length).toBeLessThan(420)
  })
})
