import { describe, expect, test } from 'bun:test'
import type { SubagentDockEntry } from './subagentDockState.js'
import {
  MAX_PERSISTED_DOCK_CHARS,
  MAX_PERSISTED_DOCK_CLEAR_MARKERS,
  MAX_PERSISTED_DOCK_FINISHED,
  MAX_PERSISTED_DOCK_SESSIONS,
  SUBAGENT_DOCK_SESSIONS_STORAGE_KEY,
  readSubagentDockSessionsFromStorage,
  writeSubagentDockSessionsToStorage,
} from './subagentDockPersistence.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'

function terminal(agentId: string, terminalAt = 10): SubagentDockEntry {
  return {
    agentId, runKey: `${agentId}:launch`, toolUseId: 'tool-1', name: 'Milo',
    task: 'Inspect restore', type: 'Explore', state: 'completed', model: 'model-a',
    recordedAccount: 'acct 2', usageLabel: '3 tools', verdict: 'Done',
    resultSummary: 'Restored safely', blockReason: null, launchOrder: 0,
    terminalAt, resumedAt: null, lastSeenAt: terminalAt, missingSince: null,
    settleUntil: null,
  }
}

describe('subagent dock durable display evidence', () => {
  // Storage is the owner for reload durability and display-only admission;
  // state-selector tests separately own lifecycle and marker interpretation.
  test('a reload preserves finished evidence and the exact cleared run', () => {
    const storage = memoryStorage()
    const entry = terminal('agent-1')
    writeSubagentDockSessionsToStorage(storage, {
      engineSession: { finished: [entry], cleared: [{ agentId: 'agent-1', runKey: entry.runKey }] },
      otherSession: { finished: [terminal('agent-2')], cleared: [] },
    })
    const reloaded = readSubagentDockSessionsFromStorage(memoryStorage(Object.fromEntries(storage.map)))
    expect(reloaded?.engineSession).toEqual({ finished: [entry], cleared: [{ agentId: 'agent-1', runKey: 'agent-1:launch' }] })
    expect(reloaded?.otherSession.cleared).toEqual([])
    expect(reloaded?.engineSession.cleared.some(marker => marker.runKey === 'agent-1:resume')).toBe(false)
  })

  test('admission strips live fields and rejects invalid terminal identities', () => {
    const valid = terminal('safe')
    const rows: unknown[] = [
      { ...valid, settleUntil: 999, missingSince: 99, blockReason: 'old', activity: 'live only', lease: { token: 'never persist' } },
      { ...terminal('running'), state: 'running' },
      { ...terminal('invalid-time'), terminalAt: -1 },
      { ...terminal('invalid-id'), runKey: {} },
      { ...terminal('large-task'), task: 'x'.repeat(2_001) },
    ]
    const storage = memoryStorage({ [SUBAGENT_DOCK_SESSIONS_STORAGE_KEY]: JSON.stringify({
      version: 1, sessions: { s: { finished: rows, cleared: [{ agentId: 'safe', runKey: valid.runKey }, { agentId: 'safe', runKey: valid.runKey }, { agentId: '', runKey: [] }] } },
    }) })
    const restored = readSubagentDockSessionsFromStorage(storage)
    expect(restored?.s.finished).toEqual([valid])
    expect(restored?.s.cleared).toEqual([{ agentId: 'safe', runKey: valid.runKey }])
    writeSubagentDockSessionsToStorage(storage, restored!)
    const saved = storage.map.get(SUBAGENT_DOCK_SESSIONS_STORAGE_KEY)!
    expect(saved).not.toContain('activity')
    expect(saved).not.toContain('lease')
    expect(readSubagentDockSessionsFromStorage(memoryStorage({ [SUBAGENT_DOCK_SESSIONS_STORAGE_KEY]: JSON.stringify({ version: 2, sessions: restored }) }))).toBeNull()
  })

  test('bounded records retain recent sessions, runs, and clear markers across repeated saves', () => {
    const storage = memoryStorage()
    const sessions = Object.fromEntries(Array.from({ length: MAX_PERSISTED_DOCK_SESSIONS + 2 }, (_, i) => [String(i), {
      finished: i === MAX_PERSISTED_DOCK_SESSIONS + 1 ? Array.from({ length: MAX_PERSISTED_DOCK_FINISHED + 2 }, (_, j) => terminal(`agent-${j}`, j)) : [],
      cleared: i === MAX_PERSISTED_DOCK_SESSIONS + 1 ? Array.from({ length: MAX_PERSISTED_DOCK_CLEAR_MARKERS + 2 }, (_, j) => ({ agentId: `agent-${j}`, runKey: `run-${j}` })) : [],
    }]))
    writeSubagentDockSessionsToStorage(storage, sessions)
    const restored = readSubagentDockSessionsFromStorage(storage)!
    expect(Object.keys(restored)).toHaveLength(MAX_PERSISTED_DOCK_SESSIONS)
    expect(restored['0']).toBeUndefined()
    expect(restored[String(MAX_PERSISTED_DOCK_SESSIONS + 1)].finished).toHaveLength(MAX_PERSISTED_DOCK_FINISHED)
    expect(restored[String(MAX_PERSISTED_DOCK_SESSIONS + 1)].finished[0]?.terminalAt).toBe(MAX_PERSISTED_DOCK_FINISHED + 1)
    expect(restored[String(MAX_PERSISTED_DOCK_SESSIONS + 1)].cleared).toHaveLength(MAX_PERSISTED_DOCK_CLEAR_MARKERS)
    expect(restored[String(MAX_PERSISTED_DOCK_SESSIONS + 1)].cleared[0]?.runKey).toBe('run-2')
    writeSubagentDockSessionsToStorage(storage, restored)
    expect(readSubagentDockSessionsFromStorage(storage)).toEqual(restored)
  })
  test('the whole record stays bounded when many sessions contain long display text', () => {
    const storage = memoryStorage()
    const sessions = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`session-${i}`, {
      finished: Array.from({ length: MAX_PERSISTED_DOCK_FINISHED }, (_, j) => ({ ...terminal(`agent-${j}`, j), task: 'x'.repeat(2_000), resultSummary: 'y'.repeat(2_000) })),
      cleared: [],
    }]))
    writeSubagentDockSessionsToStorage(storage, sessions)
    expect(storage.map.get(SUBAGENT_DOCK_SESSIONS_STORAGE_KEY)!.length).toBeLessThanOrEqual(MAX_PERSISTED_DOCK_CHARS + 100)
    const restored = readSubagentDockSessionsFromStorage(storage)!
    expect(restored['session-7'].finished).toHaveLength(MAX_PERSISTED_DOCK_FINISHED)
    expect(restored['session-0']).toBeUndefined()
    storage.setItem(SUBAGENT_DOCK_SESSIONS_STORAGE_KEY, 'x'.repeat(MAX_PERSISTED_DOCK_CHARS + 101))
    expect(readSubagentDockSessionsFromStorage(storage)).toBeNull()
  })
})
