import { describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import type { AppState } from '../../state/AppState.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import type {
  PermissionDenyDecision,
  PermissionResult,
} from '../../types/permissions.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { type ShellCommand, wrapSpawn } from '../../utils/ShellCommand.js'
import {
  checkKillOwnership,
  findKillInvocations,
  ownedShellPids,
} from './killOwnership.js'
import { BashTool } from './BashTool.js'

// A general-purpose subagent swept the machine for process ids in one Bash
// call and terminated fifteen of them in the next. Splitting discovery from
// termination defeated every command-shaped guard, and at least one of the
// process groups it stopped was not one it had started. The permission layer
// could not tell the difference because a bare number carries no owner. It
// can now: BashTool stamps the agent onto each shell task it spawns and
// ShellCommand exposes the process id behind it.

const RITCHIE = asAgentId('a8c3fed45084bfd9f')
const GOLDSTINE = asAgentId('a154c0a744d4180d7')

// The literal from the incident transcript, trimmed to three targets.
const INCIDENT_COMMAND = 'kill 37882 37884 37885'

function shellTask(
  agentId: ReturnType<typeof asAgentId>,
  pid: number | undefined,
  status: 'running' | 'completed' = 'running',
) {
  return {
    type: 'local_bash',
    status,
    command: 'cat-code -p --model gpt-5.6-luna',
    completionStatusSentInAttachment: false,
    shellCommand: { pid } as unknown as ShellCommand,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    agentId,
  }
}

function context({
  agentId,
  tasks = {},
}: {
  agentId?: ReturnType<typeof asAgentId>
  tasks?: Record<string, unknown>
}): ToolUseContext {
  const toolPermissionContext: ToolPermissionContext = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
  return {
    abortController: new AbortController(),
    agentId,
    getAppState: () =>
      ({ toolPermissionContext, tasks }) as unknown as AppState,
    setAppState: () => {},
    options: { tools: [] },
    messages: [],
  } as unknown as ToolUseContext
}

/** Narrows to the deny variant so its message is readable without a cast. */
function expectDeny(
  result: PermissionResult | null,
): PermissionDenyDecision {
  expect(result?.behavior).toBe('deny')
  if (result === null || result.behavior !== 'deny') {
    throw new Error('expected a deny decision')
  }
  return result
}

describe('kill ownership at the Bash permission entry point', () => {
  test('a subagent is denied the incident command', async () => {
    const result = await BashTool.checkPermissions(
      { command: INCIDENT_COMMAND },
      context({ agentId: RITCHIE }),
    )
    expect(expectDeny(result).message).toContain('37882')
  })

  test('the main thread is not gated', async () => {
    const result = await BashTool.checkPermissions(
      { command: INCIDENT_COMMAND },
      context({}),
    )
    expect(result.behavior).not.toBe('deny')
  })

  test('a subagent may stop a shell it started itself', async () => {
    const result = await BashTool.checkPermissions(
      { command: 'kill -9 37882' },
      context({
        agentId: RITCHIE,
        tasks: { 'task-1': shellTask(RITCHIE, 37882) },
      }),
    )
    expect(result.behavior).not.toBe('deny')
  })

  test('another agent owning the process is not the same as owning it', () => {
    const result = checkKillOwnership(
      'kill -9 37882',
      context({
        agentId: RITCHIE,
        tasks: { 'task-1': shellTask(GOLDSTINE, 37882) },
      }),
    )
    expect(result?.behavior).toBe('deny')
  })

  test('a finished task no longer lends its process id', () => {
    const result = checkKillOwnership(
      'kill 37882',
      context({
        agentId: RITCHIE,
        tasks: { 'task-1': shellTask(RITCHIE, 37882, 'completed') },
      }),
    )
    expect(result?.behavior).toBe('deny')
  })

  test('one unowned target in a list of owned ones still denies', () => {
    const result = checkKillOwnership(
      'kill 37882 37884',
      context({
        agentId: RITCHIE,
        tasks: { 'task-1': shellTask(RITCHIE, 37882) },
      }),
    )
    expect(expectDeny(result).decisionReason).toEqual({
      type: 'asyncAgent',
      reason: 'kill targets 37884 were not started by this agent',
    })
  })

  test('the deny message points at no tool the worker lacks', () => {
    const message = expectDeny(
      checkKillOwnership(INCIDENT_COMMAND, context({ agentId: RITCHIE })),
    ).message
    expect(message).not.toContain('TaskStop')
    expect(message).not.toContain('KillShell')
    expect(message).not.toContain('—')
  })
})

describe('kill forms a subagent cannot be allowed', () => {
  const denied = [
    'kill -9 37882',
    'kill -TERM 37882',
    'kill -SIGTERM 37882',
    'kill -s TERM 37882',
    'kill -n 15 37882',
    'kill -- 37882',
    'kill -- -37882',
    'kill -9 -37882',
    'sudo kill 37882',
    '/bin/kill 37882',
    'pkill -f cat-code',
    'killall node',
    'kill $(pgrep -f cat-code)',
    'kill `pgrep -f cat-code`',
    'kill $PID',
    'kill %1',
    "ps -axo pid= | rg 'cat-code' | xargs kill -9",
    'echo hi && kill 37882',
  ]
  for (const command of denied) {
    test(command, () => {
      const result = checkKillOwnership(command, context({ agentId: RITCHIE }))
      expect(result?.behavior).toBe('deny')
    })
  }
})

describe('commands that only mention stopping something', () => {
  const allowed = [
    'echo kill',
    'rg kill src/',
    'git log --grep=kill',
    'grep -rn "killall" src/',
    'cat killswitch.md',
    'kill -l',
    'ps -axo pid=,etime=,state=,command=',
    'bun test src/tools/BashTool/killOwnership.test.ts',
  ]
  for (const command of allowed) {
    test(command, () => {
      expect(checkKillOwnership(command, context({ agentId: RITCHIE }))).toBe(
        null,
      )
    })
  }
})

describe('ownership is read from a real spawned shell', () => {
  test('a running shell task lends the process id of its own child', async () => {
    if (process.platform === 'win32') {
      return
    }
    const child = spawn('/bin/sh', ['-c', 'exit 0'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const shellCommand = wrapSpawn(
      child,
      new AbortController().signal,
      60_000,
      new TaskOutput('kill_ownership_pid_test', null, false),
    )
    try {
      expect(shellCommand.pid).toBe(child.pid!)
      const task = {
        ...shellTask(RITCHIE, undefined),
        shellCommand,
      }
      expect(ownedShellPids(RITCHIE, { tasks: { t: task } } as never)).toEqual(
        new Set([child.pid!]),
      )
    } finally {
      await shellCommand.result
      shellCommand.cleanup()
    }
  })
})

describe('findKillInvocations', () => {
  test('reads a process group target as its positive group id', () => {
    expect(findKillInvocations('kill -9 -37882')).toEqual([
      { kind: 'pids', program: 'kill', pids: [37882] },
    ])
  })

  test('a signal number is not mistaken for a target', () => {
    expect(findKillInvocations('kill -15 37882')).toEqual([
      { kind: 'pids', program: 'kill', pids: [37882] },
    ])
  })

  test('every stage of a compound command is inspected', () => {
    expect(findKillInvocations('kill 1 && kill 2')).toEqual([
      { kind: 'pids', program: 'kill', pids: [1] },
      { kind: 'pids', program: 'kill', pids: [2] },
    ])
  })
})
