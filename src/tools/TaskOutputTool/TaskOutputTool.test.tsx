import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppStateStore.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  claimPendingMessagesForRequest,
  completeAgentTask,
  enqueueAgentNotification,
  queuePendingMessageIfRunning,
  registerAsyncAgent,
  settleAgentMessageDeliveries,
  submitPreparedAgentMessages,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { dequeue, resetCommandQueue } from '../../utils/messageQueueManager.js'
import {
  appendTaskOutput,
  cleanupTaskOutput,
  flushTaskOutput,
  _clearOutputsForTest,
} from '../../utils/task/diskOutput.js'
import { TaskOutputTool } from './TaskOutputTool.js'

function makeContext(appStateRef: { current: AppState }) {
  return {
    getAppState: () => appStateRef.current,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appStateRef.current = updater(appStateRef.current)
    },
    abortController: new AbortController(),
  }
}

function makeCompletedLocalAgentTask(): LocalAgentTaskState {
  return {
    id: 'agent-clean-result',
    type: 'local_agent',
    status: 'completed',
    description: 'Inspect sessions page',
    startTime: 1,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-clean-result',
    prompt: 'Inspect sessions page',
    agentType: 'Explore',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    result: {
      agentId: 'agent-clean-result',
      agentType: 'Explore',
      content: [
        {
          type: 'text',
          text: 'Clean final answer from the subagent.',
        },
      ],
      totalToolUseCount: 3,
      totalDurationMs: 42,
      totalTokens: 100,
    },
  }
}

function makeRunningLocalAgentTask(): LocalAgentTaskState {
  return {
    ...makeCompletedLocalAgentTask(),
    id: 'agent-running-result',
    status: 'running',
    outputFile: '',
    notified: false,
    agentId: 'agent-running-result',
    result: undefined,
  }
}

describe('TaskOutputTool', () => {
  test('prompt advertises TaskOutput as the safe structured path', async () => {
    await expect(TaskOutputTool.description()).resolves.toContain(
      'Read structured output from a background task',
    )

    const prompt = await TaskOutputTool.prompt()

    expect(prompt).toContain(
      'Prefer this tool over reading task output files directly.',
    )
    expect(prompt).toContain(
      'For local agents, the output file can be a full JSONL transcript; this tool returns the clean final answer when available.',
    )
    expect(prompt).not.toContain('DEPRECATED')
    expect(prompt).not.toContain(['Read', 'that file directly'].join(' '))
    expect(prompt).not.toContain(
      ['prefer', 'Read on the task output file path'].join(' '),
    )
    expect(prompt).not.toMatch(/deprecated/i)
    expect(prompt).not.toMatch(/\bRead\b[^\n.]*\bdirectly\b/i)
    expect(prompt).not.toMatch(
      /\b(?:prefer|use)\s+(?:the\s+)?Read\b[^\n.]*\b(?:task output|output file|file path|path)\b/i,
    )
    expect(prompt).toContain(
      'For agents, await automatic notification. Use block=true for intentional shell joins or user-requested waits.',
    )
    expect(prompt).toContain(
      'running local agents do not return transcript content',
    )
  })

  test.each([false, true])('local agent output returns the clean final answer instead of raw disk transcript output (block=%s)', async block => {
    const taskId = 'agent-clean-result'
    const rawTranscript =
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Raw JSONL transcript output that should not be returned.',
            },
          ],
        },
      }) + '\n'

    await cleanupTaskOutput(taskId)
    appendTaskOutput(taskId, rawTranscript)
    await flushTaskOutput(taskId)

    try {
      const appStateRef = { current: getDefaultAppState() }
      appStateRef.current = {
        ...appStateRef.current,
        tasks: {
          ...appStateRef.current.tasks,
          [taskId]: makeCompletedLocalAgentTask(),
        },
      }

      const result = await TaskOutputTool.call(
        {
          task_id: taskId,
          block,
          timeout: 0,
        },
        makeContext(appStateRef) as never,
        undefined as never,
        undefined as never,
      )

      expect(result.data.retrieval_status).toBe('success')
      expect(result.data.task?.output).toBe(
        'Clean final answer from the subagent.',
      )
      expect(result.data.task?.result).toBe(
        'Clean final answer from the subagent.',
      )
      expect(result.data.task?.output).not.toContain(
        'Raw JSONL transcript output',
      )
      expect(result.data.task?.result).not.toContain(
        'Raw JSONL transcript output',
      )
      expect(appStateRef.current.tasks[taskId]?.notified).toBe(true)
    } finally {
      await cleanupTaskOutput(taskId)
    }
  })

  for (const priorRunId of ['prior-run', undefined]) {
    for (const completeBeforeRead of [false, true]) {
      test(`reading ${priorRunId ?? 'legacy'} output preserves a resumed worker's ${completeBeforeRead ? 'completed' : 'running'} notification`, async () => {
        resetCommandQueue()
        const prior = { ...makeCompletedLocalAgentTask(), runId: priorRunId }
        const state = { current: { ...getDefaultAppState(), tasks: { [prior.id]: prior } } }
        const context = makeContext(state)
        const reading = TaskOutputTool.call(
          { task_id: prior.id, block: true, timeout: 0 },
          context as never, undefined as never, undefined as never,
        )
        // Resume replaces the logical task while the old output read is
        // suspended at its completion await, before it acknowledges that run.
        const resumed = registerAsyncAgent({
          agentId: prior.id, description: prior.description, prompt: 'Continue the work',
          selectedAgent: {
            agentType: 'general-purpose', source: 'built-in', baseDir: 'built-in',
            whenToUse: 'fixture', tools: [], getSystemPrompt: () => 'fixture',
          },
          setAppState: context.setAppState,
        })
        const result = { ...prior.result!, content: [{ type: 'text' as const, text: 'Resumed worker result' }] }
        const complete = () => completeAgentTask(result, context.setAppState, resumed.runId)
        try {
          if (completeBeforeRead) complete()
          const read = await reading
          expect(read.data.task?.output).toBe('Clean final answer from the subagent.')
          expect(state.current.tasks[prior.id].notified).toBe(false)
          if (!completeBeforeRead) complete()
          enqueueAgentNotification({
            taskId: prior.id, description: prior.description, status: 'completed',
            finalMessage: 'Resumed worker result', runId: resumed.runId,
            setAppState: context.setAppState,
          })
          const notification = dequeue()
          expect(notification?.taskRunId).toBe(resumed.runId)
          expect(notification?.value).toContain('Resumed worker result')
          expect(dequeue()).toBeUndefined()
        } finally {
          complete()
          resetCommandQueue()
          await _clearOutputsForTest()
          await cleanupTaskOutput(prior.id)
        }
      })
    }
  }

  test('running local agent non-blocking output does not expose raw transcript content', async () => {
    const taskId = 'agent-running-result'
    const rawTranscript =
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Raw JSONL transcript output that should not be returned.',
            },
          ],
        },
      }) + '\n'

    await cleanupTaskOutput(taskId)
    appendTaskOutput(taskId, rawTranscript)
    await flushTaskOutput(taskId)

    try {
      const appStateRef = { current: getDefaultAppState() }
      appStateRef.current = {
        ...appStateRef.current,
        tasks: {
          ...appStateRef.current.tasks,
          [taskId]: makeRunningLocalAgentTask(),
        },
      }

      const result = await TaskOutputTool.call(
        {
          task_id: taskId,
          block: false,
          timeout: 0,
        },
        makeContext(appStateRef) as never,
        undefined as never,
        undefined as never,
      )

      expect(result.data.retrieval_status).toBe('not_ready')
      expect(result.data.task?.output).toBe(
        'Still running; await the automatic completion notification.',
      )
      expect(result.data.task?.result).toBeUndefined()
      expect(result.data.task?.output).not.toContain(
        'Raw JSONL transcript output',
      )
      expect(appStateRef.current.tasks[taskId]?.notified).toBe(false)
    } finally {
      await cleanupTaskOutput(taskId)
    }
  })

  test('running output reports parent messages from acceptance through completed receipt', async () => {
    const task = { ...makeRunningLocalAgentTask(), runId: 'current-run' }
    const state = { current: { ...getDefaultAppState(), tasks: { [task.id]: task } } }
    const context = makeContext(state)
    const output = async (block = false) => (await TaskOutputTool.call(
      { task_id: task.id, block, timeout: 0 },
      context as never, undefined as never, undefined as never,
    )).data.task!.output

    queuePendingMessageIfRunning(task.id, 'Report the current result.', context.setAppState)
    expect(await output()).toContain('not seen yet: "Report the current result."')
    claimPendingMessagesForRequest(task.id, task.runId, context.setAppState)
    expect(await output()).toContain('not seen yet: "Report the current result."')
    const ids = submitPreparedAgentMessages(task.id, task.runId, 'request-1', context.setAppState)
    expect(await output()).toContain('not seen yet: "Report the current result."')
    settleAgentMessageDeliveries(task.id, ids, task.runId, 'delivered', 'completed response', context.setAppState)
    const seen = await output(true)
    expect(seen).toContain('Still running; await the automatic completion notification.')
    expect(seen).not.toContain('block=true')
    expect(seen).toContain('seen: "Report the current result."')
    expect(seen).not.toContain('not seen yet')
    expect(state.current.tasks[task.id].notified).toBe(false)

    for (let i = 0; i < 25; i++) {
      queuePendingMessageIfRunning(task.id, `Completed message ${i}`, context.setAppState)
      claimPendingMessagesForRequest(task.id, task.runId, context.setAppState)
      const submitted = submitPreparedAgentMessages(task.id, task.runId, `request-${i + 2}`, context.setAppState)
      settleAgentMessageDeliveries(task.id, submitted, task.runId, 'delivered', 'completed response', context.setAppState)
    }
    queuePendingMessageIfRunning(task.id, 'Unresolved message', context.setAppState)
    const records = state.current.tasks[task.id].pendingMessages
    expect(records.filter(message => message.status === 'delivered')).toHaveLength(20)
    expect(records.find(message => message.message === 'Unresolved message')?.status).toBe('pending')
    expect(await output()).toContain('not seen yet: "Unresolved message"')
  })

  test('message receipts are bounded, excerpted, and exclude other runs and worker senders', async () => {
    const task: LocalAgentTaskState = {
      ...makeRunningLocalAgentTask(),
      runId: 'current-run',
      pendingMessages: [
        ...Array.from({ length: 25 }, (_, i) => ({
          id: `old-${i}`, message: `older message ${i}`, acceptedAt: i,
          runId: 'current-run', status: 'delivered' as const,
        })),
        { id: 'previous', message: 'previous run hidden', runId: 'previous-run', acceptedAt: 30, status: 'uncertain' },
        { id: 'sibling', message: 'sibling hidden', originAgentId: 'sibling' as never, runId: 'current-run', acceptedAt: 31, status: 'submitted' },
        { id: 'uncertain', message: 'Possibly received\n' + 'x'.repeat(1000), runId: 'current-run', acceptedAt: 32, status: 'uncertain' },
        { id: 'undelivered', message: 'Could not deliver', runId: 'current-run', acceptedAt: 33, status: 'undelivered' },
      ],
    }
    const state = { current: { ...getDefaultAppState(), tasks: { [task.id]: task } } }
    const result = await TaskOutputTool.call(
      { task_id: task.id, block: false, timeout: 0 },
      makeContext(state) as never, undefined as never, undefined as never,
    )
    const output = result.data.task!.output
    expect(output).toContain('not confirmed: "Possibly received ')
    expect(output).toContain('not delivered: "Could not deliver"')
    expect(output).not.toContain('previous run hidden')
    expect(output).not.toContain('sibling hidden')
    expect(output).not.toContain('older message 0"')
    expect(output.match(/^- /gm)).toHaveLength(20)
    expect(output.length).toBeLessThan(4000)
    expect(output).not.toContain('x'.repeat(200))
    expect(await TaskOutputTool.prompt(undefined as never)).toContain(
      "Seen: the worker's model received the message. Not seen yet: it is waiting for the worker's next step. Not confirmed: the request carrying it was cut or failed, so the worker may or may not have read it.",
    )
  })
})
