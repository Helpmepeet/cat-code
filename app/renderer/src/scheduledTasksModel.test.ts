import { describe, expect, test } from 'bun:test'
import { parseScheduledTaskCommand, type ScheduledRun, type ScheduledTask } from '../../shared/scheduledTasks.js'
import {
  createResponseOrder,
  displayPath,
  draftAfterRefusedSave,
  effortChoicesFor,
  draftProblems,
  draftToInput,
  editTaskDraft,
  formatRunTime,
  newTaskDraft,
  nextRunText,
  orderTasks,
  partitionRuns,
  previewNextRun,
  scheduleLabel,
} from './scheduledTasksModel.js'

const ID = '11111111-1111-4111-8111-111111111111'
const SESSION = '22222222-2222-4222-8222-222222222222'
const NOW = Date.UTC(2026, 9, 13, 5, 0)

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: ID, name: 'Maps', prompt: 'Refresh maps', enabled: true, cwd: '/repo/cat-code',
    schedule: { kind: 'daily', time: '03:00', timeZone: 'Asia/Bangkok', day: 0 },
    model: '', effort: 'default', permissionMode: 'auto', createdAt: NOW - 1000, nextRunAt: NOW + 3600_000,
    ...overrides,
  }
}

function run(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: crypto.randomUUID(), taskId: ID, taskName: 'Maps', appSessionId: crypto.randomUUID(),
    scheduledAt: NOW, startedAt: NOW, endedAt: null, status: 'running', summary: '', ...overrides,
  }
}

describe('draft to save input', () => {
  test('a new task names a project handle and never a path, and the receiving parser accepts it', () => {
    const draft = { ...newTaskDraft('Asia/Bangkok'), name: ' Maps ', prompt: 'Refresh', project: { kind: 'workspace' as const, workspaceId: SESSION } }
    const input = draftToInput(draft, null)
    expect(input).toEqual({
      name: 'Maps', prompt: 'Refresh', enabled: true, model: '', effort: 'default', permissionMode: 'default',
      schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Bangkok', day: 1 }, workspaceId: SESSION,
    })
    expect(parseScheduledTaskCommand({ type: 'save', task: input })).not.toBeNull()
  })

  test('an edit keeps the saved project and takes enabled from the latest snapshot', () => {
    const draft = editTaskDraft(task({ enabled: true }))
    const input = draftToInput({ ...draft, scheduleKind: 'interval', minutes: '90' }, task({ enabled: false }))
    expect(input.id).toBe(ID)
    expect(input.enabled).toBe(false)
    expect(input).not.toHaveProperty('workspaceId')
    expect(input).not.toHaveProperty('cwdToken')
    expect(input.schedule).toEqual({ kind: 'interval', minutes: 90 })
    expect(parseScheduledTaskCommand({ type: 'save', task: input })).not.toBeNull()
  })

  test('a refused save spends only the submitted picker token', () => {
    const draft = { ...newTaskDraft(), project: { kind: 'folder' as const, cwdToken: 'spent' } }
    expect(draftAfterRefusedSave(draft, 'spent').project).toEqual({ kind: 'none', reason: 'token-spent' })
    expect(draftAfterRefusedSave({ ...draft, project: { kind: 'folder', cwdToken: 'fresh' } }, 'spent').project).toEqual({ kind: 'folder', cwdToken: 'fresh' })
    expect(draftProblems(draftAfterRefusedSave(draft, 'spent')).project).toBe('Choose the folder again.')
  })

  test('the next-run preview uses the scheduler rule in the saved zone', () => {
    const draft = { ...newTaskDraft('Asia/Bangkok'), time: '03:00' }
    expect(previewNextRun(draft, NOW)).toBe(Date.UTC(2026, 9, 13, 20, 0))
    expect(previewNextRun({ ...draft, scheduleKind: 'interval', minutes: '90' }, NOW)).toBe(NOW + 90 * 60_000)
    expect(previewNextRun({ ...draft, timeZone: 'Mars/Base' }, NOW)).toBeNull()
  })

  test('problems mirror the parser limits', () => {
    const base = { ...newTaskDraft('UTC'), name: 'n', prompt: 'p', project: { kind: 'saved' as const } }
    expect(draftProblems(base)).toEqual({})
    expect(draftProblems({ ...base, timeZone: 'Mars/Base' }).timeZone).toBeDefined()
    expect(draftProblems({ ...base, scheduleKind: 'interval', minutes: '10081' }).schedule).toBeDefined()
    expect(draftProblems({ ...base, scheduleKind: 'interval', minutes: '1.5' }).schedule).toBeDefined()
    expect(draftProblems({ ...base, model: 'gpt 6' }).model).toBeDefined()
    const longContext = { ...base, taskId: ID, model: 'opus[1m]' }
    expect(draftProblems(longContext)).toEqual({})
    expect(parseScheduledTaskCommand({ type: 'save', task: draftToInput(longContext, task()) })).not.toBeNull()
    expect(draftProblems({ ...base, prompt: 'é'.repeat(32 * 1024 + 1) }).prompt).toBeDefined()
    expect(draftProblems({ ...base, project: { kind: 'none' } }).project).toBe('Choose a project.')
  })
})

describe('presentation', () => {
  test('schedules read as their recurrence', () => {
    expect(scheduleLabel({ kind: 'weekly', time: '08:30', timeZone: 'UTC', day: 1 }, 'UTC')).toBe('Mondays at 08:30')
    expect(scheduleLabel({ kind: 'weekdays', time: '08:30', timeZone: 'Asia/Bangkok', day: 0 }, 'UTC')).toBe('Weekdays at 08:30 Asia/Bangkok')
    expect(scheduleLabel({ kind: 'interval', minutes: 120 })).toBe('Every 2 hours')
    expect(scheduleLabel({ kind: 'interval', minutes: 45 })).toBe('Every 45 min')
  })

  test('run times are calendar relative in the viewer zone', () => {
    expect(formatRunTime(NOW, NOW, 'UTC')).toBe('Today 05:00')
    expect(formatRunTime(NOW + 86400_000, NOW, 'UTC')).toBe('Tomorrow 05:00')
    expect(formatRunTime(NOW + 3 * 86400_000, NOW, 'UTC')).toBe('Fri 05:00')
    expect(formatRunTime(NOW + 10 * 86400_000, NOW, 'UTC')).toBe('Oct 23 05:00')
  })

  test('the next run reflects pause and the one-unfinished-run rule', () => {
    expect(nextRunText(task({ enabled: false }), [], NOW)).toBe('Paused')
    expect(nextRunText(task({ nextRunAt: NOW - 1 }), [], NOW)).toBe('Due now')
    expect(nextRunText(task({ nextRunAt: NOW - 1 }), [run({ status: 'waiting' })], NOW)).toBe('After this run')
    expect(nextRunText(task({ nextRunAt: NOW - 1 }), [run({ status: 'completed', endedAt: NOW })], NOW)).toBe('Due now')
  })

  test('tasks order by dispatch, paused last', () => {
    const order = orderTasks([
      task({ id: 'a', name: 'Paused', enabled: false }),
      task({ id: 'b', nextRunAt: NOW + 2 }),
      task({ id: 'c', nextRunAt: NOW + 1 }),
    ]).map(entry => entry.id)
    expect(order).toEqual(['c', 'b', 'a'])
  })

  test('answers needed lead the unfinished runs; history is newest first', () => {
    const waiting = run({ status: 'waiting', startedAt: NOW - 50 })
    const running = run({ status: 'running', startedAt: NOW })
    const old = run({ status: 'completed', startedAt: NOW - 100, endedAt: NOW })
    const recent = run({ status: 'failed', startedAt: NOW - 10, endedAt: NOW })
    const { active, finished } = partitionRuns([old, running, recent, waiting])
    expect(active).toEqual([waiting, running])
    expect(finished).toEqual([recent, old])
  })

})

test('a response issued before an applied one is dropped', () => {
  const order = createResponseOrder()
  const poll = order.issue()
  const save = order.issue()
  expect(order.accept(save)).toBe(true)
  expect(order.accept(poll)).toBe(false)
  expect(order.accept(order.issue())).toBe(true)
})

test('effort choices use the catalog for explicit and default models, not the parser union', () => {
  const options = [
    { value: 'gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai' as const, effortOptions: ['low', 'high'] },
    { value: 'haiku', label: 'Haiku', provider: 'anthropic' as const, effortOptions: [] },
  ]
  expect(effortChoicesFor('gpt-6-sol', options, ['medium'])).toEqual(['default', 'low', 'high'])
  expect(effortChoicesFor('haiku', options, ['medium'])).toEqual(['default'])
  expect(effortChoicesFor('', options, ['medium'])).toEqual(['default', 'medium'])
  expect(effortChoicesFor('unknown-saved-model', options, ['medium'])).toEqual(['default'])
})

test('paths shorten only the home folder', () => {
  expect(displayPath('/Users/pt/cat-code')).toBe('~/cat-code')
  expect(displayPath('/home/pt')).toBe('~')
  expect(displayPath('/private/tmp/project')).toBe('/private/tmp/project')
})
