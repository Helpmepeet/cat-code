import { describe, expect, test } from 'bun:test'
import { makeDreamProgressWatcher } from './autoDream.js'
import { registerDreamTask } from '../../tasks/DreamTask/DreamTask.js'
import type { AppState } from '../../state/AppState.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../../tools/FilePatchTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import type { AssistantMessage } from '../../types/message.js'

describe('makeDreamProgressWatcher', () => {
  test('tracks all files touched by Apply_patch including multi-file patches and moves', () => {
    let state: AppState = {
      tasks: {},
    } as unknown as AppState

    const setAppState = (updater: (s: AppState) => AppState) => {
      state = updater(state)
    }

    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: 1,
      priorMtime: 0,
      abortController: new AbortController(),
    })

    const watcher = makeDreamProgressWatcher(taskId, setAppState)

    const patchInput = `*** Begin Patch
*** Update File: memory/user.md
*** Move to: memory/user_profile.md
@@
-name: Bob
+name: Alice
*** Add File: memory/feedback.md
+feedback testing
*** End Patch
`

    const assistantMsg: AssistantMessage = {
      uuid: 'msg-patch',
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Updating memory files' },
          {
            type: 'tool_use',
            name: FILE_PATCH_TOOL_NAME,
            input: { input: patchInput },
          },
        ],
      },
    } as AssistantMessage

    watcher(assistantMsg)

    const task = state.tasks[taskId] as any
    expect(task).toBeDefined()
    expect(task.phase).toBe('updating')
    expect(task.filesTouched).toEqual([
      'memory/user.md',
      'memory/user_profile.md',
      'memory/feedback.md',
    ])
  })

  test('tracks files touched by Edit and Write alongside Apply_patch', () => {
    let state: AppState = {
      tasks: {},
    } as unknown as AppState

    const setAppState = (updater: (s: AppState) => AppState) => {
      state = updater(state)
    }

    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: 1,
      priorMtime: 0,
      abortController: new AbortController(),
    })

    const watcher = makeDreamProgressWatcher(taskId, setAppState)

    const msg: AssistantMessage = {
      uuid: 'msg-combo',
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: FILE_EDIT_TOOL_NAME,
            input: { file_path: 'memory/rules.md' },
          },
          {
            type: 'tool_use',
            name: FILE_WRITE_TOOL_NAME,
            input: { file_path: 'memory/index.md' },
          },
        ],
      },
    } as AssistantMessage

    watcher(msg)

    const task = state.tasks[taskId] as any
    expect(task.filesTouched).toEqual(['memory/rules.md', 'memory/index.md'])
  })

  test('does not add filesTouched for non-mutation tools', () => {
    let state: AppState = {
      tasks: {},
    } as unknown as AppState

    const setAppState = (updater: (s: AppState) => AppState) => {
      state = updater(state)
    }

    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: 1,
      priorMtime: 0,
      abortController: new AbortController(),
    })

    const watcher = makeDreamProgressWatcher(taskId, setAppState)

    const msg: AssistantMessage = {
      uuid: 'msg-read',
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: 'memory/rules.md' },
          },
        ],
      },
    } as AssistantMessage

    watcher(msg)

    const task = state.tasks[taskId] as any
    expect(task.filesTouched).toEqual([])
  })
})
