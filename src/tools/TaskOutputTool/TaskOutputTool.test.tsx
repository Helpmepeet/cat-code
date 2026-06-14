import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppStateStore.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  appendTaskOutput,
  cleanupTaskOutput,
  flushTaskOutput,
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
    await expect(TaskOutputTool.description()).resolves.toBe(
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
      'Use block=true (default) to wait for task completion when your next step depends on the result.',
    )
    expect(prompt).toContain(
      'running local agents do not return transcript content',
    )
  })

  test('local agent output returns the clean final answer instead of raw disk transcript output', async () => {
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
          block: false,
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
        'Final answer is not available yet. Use block=true to wait for completion.',
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
})
