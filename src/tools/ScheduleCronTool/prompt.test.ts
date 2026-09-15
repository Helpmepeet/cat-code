import { describe, expect, test } from 'bun:test'
import { getCronFilePath } from '../../utils/cronTasks.js'
import { buildMissedTaskNotification } from '../../utils/cronScheduler.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  buildCronDeletePrompt,
  buildCronListPrompt,
} from './prompt.js'

describe('cron tool prompts name the file the code actually writes', () => {
  // The prompts cited .claude/scheduled_tasks.json; cronTasks.ts writes
  // .cat-code/scheduled_tasks.json, so the model was told a path that does
  // not exist.
  const relPath = getCronFilePath('/tmp/cron-prompt-test').slice(
    '/tmp/cron-prompt-test/'.length,
  )

  const durableTexts = [
    buildCronCreateDescription(true),
    buildCronCreatePrompt(true),
    buildCronDeletePrompt(true),
    buildCronListPrompt(true),
  ]

  test('every durable-mode prompt cites the real relative path', () => {
    expect(relPath).toBe('.cat-code/scheduled_tasks.json')

    for (const text of durableTexts) {
      expect(text).toContain(relPath)
      expect(text).not.toContain('.claude/scheduled_tasks.json')
    }
  })

  test('the missed-task notification cites the real path too', () => {
    const notification = buildMissedTaskNotification([
      {
        id: 'task-1',
        cron: '0 9 * * *',
        prompt: 'check the deploy',
        createdAt: 0,
      },
    ])

    expect(notification).toContain(relPath)
    expect(notification).not.toContain('.claude/scheduled_tasks.json')
  })
})
