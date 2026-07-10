import { describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../../tools/TodoWriteTool/constants.js'
import { extractTodoListFromLog } from './RemoteAgentTask.js'

function assistantToolUseMessage(
  toolName: string,
  callId: string,
  input: Record<string, unknown>,
): SDKMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${callId}`,
    timestamp: new Date().toISOString(),
    message: {
      id: `msg-${callId}`,
      type: 'message',
      role: 'assistant',
      model: 'gpt-5.6-luna',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'tool_use', id: callId, name: toolName, input }],
    },
  } as SDKMessage
}

function userToolResultMessage(callId: string, content: string): SDKMessage {
  return {
    type: 'user',
    uuid: `user-${callId}`,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content }],
    },
  } as SDKMessage
}

describe('extractTodoListFromLog', () => {
  test('projects TaskCreate and TaskUpdate activity into remote worker progress', () => {
    const log: SDKMessage[] = [
      assistantToolUseMessage(TASK_CREATE_TOOL_NAME, 'create-1', {
        subject: 'Investigate task split',
        description: 'Trace TaskCreate vs TodoWrite',
        activeForm: 'Investigating task split',
      }),
      userToolResultMessage(
        'create-1',
        'Task #7 created successfully: Investigate task split',
      ),
      assistantToolUseMessage(TASK_UPDATE_TOOL_NAME, 'update-1', {
        taskId: '7',
        status: 'in_progress',
      }),
      assistantToolUseMessage(TASK_UPDATE_TOOL_NAME, 'update-2', {
        taskId: '7',
        status: 'completed',
      }),
    ]

    expect(extractTodoListFromLog(log)).toEqual([
      {
        content: 'Investigate task split',
        status: 'completed',
        activeForm: 'Investigating task split',
      },
    ])
  })

  test('prefers the latest task-management system in mixed transcripts', () => {
    const log: SDKMessage[] = [
      assistantToolUseMessage(TASK_CREATE_TOOL_NAME, 'create-1', {
        subject: 'Old task system entry',
        description: 'Should be ignored after TodoWrite',
      }),
      userToolResultMessage(
        'create-1',
        'Task #4 created successfully: Old task system entry',
      ),
      assistantToolUseMessage(TODO_WRITE_TOOL_NAME, 'todo-1', {
        todos: [
          {
            content: 'Follow the newer transcript state',
            status: 'in_progress',
            activeForm: 'Following the newer transcript state',
          },
        ],
      }),
    ]

    expect(extractTodoListFromLog(log)).toEqual([
      {
        content: 'Follow the newer transcript state',
        status: 'in_progress',
        activeForm: 'Following the newer transcript state',
      },
    ])
  })

  test('drops stale v2 tasks when the transcript switches back from TodoWrite to v2 tasks', () => {
    const log: SDKMessage[] = [
      assistantToolUseMessage(TASK_CREATE_TOOL_NAME, 'create-1', {
        subject: 'Stale v2 task',
        description: 'Should not survive past TodoWrite',
      }),
      userToolResultMessage(
        'create-1',
        'Task #4 created successfully: Stale v2 task',
      ),
      assistantToolUseMessage(TODO_WRITE_TOOL_NAME, 'todo-1', {
        todos: [
          {
            content: 'Temporary legacy task state',
            status: 'completed',
            activeForm: 'Completing temporary legacy task state',
          },
        ],
      }),
      assistantToolUseMessage(TASK_CREATE_TOOL_NAME, 'create-2', {
        subject: 'Fresh v2 task',
        description: 'Should be the only projected task',
      }),
      userToolResultMessage(
        'create-2',
        'Task #8 created successfully: Fresh v2 task',
      ),
    ]

    expect(extractTodoListFromLog(log)).toEqual([
      {
        content: 'Fresh v2 task',
        status: 'pending',
        activeForm: 'Fresh v2 task',
      },
    ])
  })
})
