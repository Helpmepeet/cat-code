import { expect, test } from 'bun:test'
import type {
  ExtensionsSnapshot,
  ExtensionsSnapshotFrame,
  HookEntry,
  LifecycleFrame,
  SkillEntry,
} from '../../shared/protocol.js'
import {
  createExtensionsState,
  reduceExtensionsState,
  selectExtensionsSnapshot,
  selectHookGroups,
  selectSkillGroups,
} from './extensionsState.js'

function skill(fields: Partial<SkillEntry> & { name: string; source: SkillEntry['source'] }): SkillEntry {
  return {
    context: 'inline',
    disableModelInvocation: false,
    userInvocable: true,
    description: `desc ${fields.name}`,
    ...fields,
  }
}

function snapshot(fields: Partial<ExtensionsSnapshot> = {}): ExtensionsSnapshot {
  return { mcp: [], plugins: [], skills: [], hooks: [], notes: [], ...fields }
}

function frame(sessionId: string, extensions: ExtensionsSnapshot): ExtensionsSnapshotFrame {
  return { kind: 'extensions.snapshot', protocolVersion: 1, sessionId, extensions }
}

test('reducer stores the snapshot per session and select reads it back', () => {
  let state = createExtensionsState()
  state = reduceExtensionsState(state, { type: 'frame', frame: frame('s1', snapshot({ notes: ['n'] })) })
  expect(selectExtensionsSnapshot(state, 's1')?.notes).toEqual(['n'])
  expect(selectExtensionsSnapshot(state, 's2')).toBeNull()
  expect(selectExtensionsSnapshot(state, null)).toBeNull()
})

test('a lifecycle frame drops the stale snapshot only for a tracked session', () => {
  let state = createExtensionsState()
  state = reduceExtensionsState(state, { type: 'frame', frame: frame('s1', snapshot()) })
  const lifecycle: LifecycleFrame = {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId: 's1',
    status: 'disconnected',
  }
  state = reduceExtensionsState(state, { type: 'frame', frame: lifecycle })
  expect(selectExtensionsSnapshot(state, 's1')).toBeNull()
  // An untracked session is not materialized into an empty slot.
  const before = state
  state = reduceExtensionsState(state, {
    type: 'frame',
    frame: { ...lifecycle, sessionId: 'untracked' },
  })
  expect(state).toBe(before)
})

test('selectSkillGroups groups by source in the canonical order and drops empty groups', () => {
  const skills: SkillEntry[] = [
    skill({ name: 'b', source: 'userSettings' }),
    skill({ name: 'a', source: 'projectSettings' }),
    skill({ name: 'c', source: 'plugin', pluginName: 'kit' }),
  ]
  const groups = selectSkillGroups(snapshot({ skills }))
  expect(groups.map(g => g.source)).toEqual(['userSettings', 'projectSettings', 'plugin'])
  expect(groups.map(g => g.skills.length)).toEqual([1, 1, 1])
})

test('selectSkillGroups returns [] when the slice is null', () => {
  expect(selectSkillGroups(snapshot({ skills: null }))).toEqual([])
  expect(selectSkillGroups(null)).toEqual([])
})

test('selectHookGroups preserves the snapshot event order', () => {
  const hooks: HookEntry[] = [
    { event: 'PreToolUse', type: 'command', source: 'userSettings', async: false, displayLine: 'a' },
    { event: 'PreToolUse', type: 'command', source: 'userSettings', async: false, displayLine: 'b' },
    { event: 'Stop', type: 'command', source: 'userSettings', async: false, displayLine: 'c' },
  ]
  const groups = selectHookGroups(snapshot({ hooks }))
  expect(groups.map(g => g.event)).toEqual(['PreToolUse', 'Stop'])
  expect(groups[0]?.hooks.length).toBe(2)
})
