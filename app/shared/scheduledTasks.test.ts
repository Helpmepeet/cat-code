import { expect, test } from 'bun:test'
import { parseScheduledTaskCommand } from './scheduledTasks.js'

const task = { name: 'Refresh maps', prompt: 'Review committed source', enabled: true, model: 'gpt-6-luna', effort: 'max', permissionMode: 'auto', cwdToken: 'picker-token', schedule: { kind: 'daily', time: '03:00', timeZone: 'Asia/Bangkok', day: 0 } }
test('closed scheduled-task boundary accepts saved intent and rejects filesystem or permission authority', () => {
  expect(parseScheduledTaskCommand({ type: 'save', task })).not.toBeNull()
  for (const invalid of [
    { ...task, cwd: '/private' }, { ...task, resumeEngineSessionId: crypto.randomUUID() },
    { ...task, permissionMode: 'bypassPermissions' }, { ...task, enabled: 'true' },
    { ...task, prompt: 'x'.repeat(65537) }, { ...task, model: 'x\nINJECT' },
    { ...task, schedule: { ...task.schedule, timeZone: 'Not/AZone' } },
    { ...task, schedule: { ...task.schedule, time: '24:00' } },
    { ...task, schedule: { ...task.schedule, minutes: 2 } },
    { ...task, workspaceSessionId: crypto.randomUUID() },
    { ...task, permissionMode: { toString: 0 } },
    { ...task, schedule: { ...task.schedule, kind: { toString: 0 } } },
  ]) expect(parseScheduledTaskCommand({ type: 'save', task: invalid })).toBeNull()
  expect(parseScheduledTaskCommand({ type: { toString: 0 } })).toBeNull()
  expect(parseScheduledTaskCommand({ type: 'run', id: crypto.randomUUID(), cwd: '/private' })).toBeNull()
  expect(parseScheduledTaskCommand({ type: 'workspace-maps', workspaceSessionId: '/private' })).toBeNull()
})
