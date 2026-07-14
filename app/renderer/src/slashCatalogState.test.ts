import { expect, test } from 'bun:test'
import {
  createSlashCatalogState,
  reduceSlashCatalogState,
  selectSlashCatalog,
} from './slashCatalogState.js'
import type { ServerFrame, SlashCatalogEntry } from '../../shared/protocol.js'

const CATALOG: SlashCatalogEntry[] = [
  { name: 'help', description: 'Show help' },
  { name: 'model', description: 'Switch the model', argumentHint: '<name>' },
]

function catalogFrame(
  sessionId: string,
  commands: SlashCatalogEntry[],
): ServerFrame {
  return { kind: 'slash-catalog.snapshot', protocolVersion: 1, sessionId, commands }
}

test('stores the slash catalog per session and selects it', () => {
  let state = createSlashCatalogState()
  state = reduceSlashCatalogState(state, {
    type: 'frame',
    frame: catalogFrame('s1', CATALOG),
  })
  expect(selectSlashCatalog(state, 's1')).toEqual(CATALOG)
  // Unseen session / null → empty, not undefined (the picker maps over it).
  expect(selectSlashCatalog(state, 's2')).toEqual([])
  expect(selectSlashCatalog(state, null)).toEqual([])
})

test('a lifecycle frame clears a tracked session but leaves untracked ones alone', () => {
  let state = createSlashCatalogState()
  state = reduceSlashCatalogState(state, {
    type: 'frame',
    frame: catalogFrame('s1', CATALOG),
  })
  const before = state
  state = reduceSlashCatalogState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 1, sessionId: 's2', status: 'disconnected' },
  })
  expect(state).toBe(before) // untracked session → no change
  state = reduceSlashCatalogState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 1, sessionId: 's1', status: 'disconnected' },
  })
  expect(selectSlashCatalog(state, 's1')).toEqual([])
})
