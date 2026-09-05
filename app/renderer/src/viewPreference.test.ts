/**
 * The frozen envelope, proved against records in the shape the app has always
 * written.
 *
 * Every string below is a literal `localStorage` value of the kind the operator
 * already has on disk, typed out here rather than produced by the writer — a
 * round-trip through today's code would pass even if the key, the field name or
 * the envelope had silently changed. Each preference's own suite still owns its
 * validator and its defaults; this one owns the wire.
 */
import { expect, test } from 'bun:test'
import {
  ACCENT_STORAGE_KEY,
  readAccentFromStorage,
  writeAccentToStorage,
} from './accentTheme.js'
import { CODE_THEME_STORAGE_KEY, readCodeThemeFromStorage } from './codeTheme.js'
import {
  COLOR_SCHEME_STORAGE_KEY,
  readColorSchemeFromStorage,
} from './colorScheme.js'
import { GLASS_STORAGE_KEY, readGlassFromStorage } from './glassMode.js'
import {
  PROSE_ARRIVAL_STORAGE_KEY,
  readProseArrivalFromStorage,
} from './proseArrival.js'
import {
  REASONING_LAYOUT_STORAGE_KEY,
  readReasoningLayoutFromStorage,
} from './reasoningLayout.js'
import {
  TOOL_CARD_STYLE_STORAGE_KEY,
  readToolCardStyleFromStorage,
} from './toolCardStyle.js'
import {
  TOOLS_EXPANDED_STORAGE_KEY,
  readToolsExpandedFromStorage,
} from './toolsExpanded.js'
import {
  PROMPT_DRAFTS_STORAGE_KEY,
  readPromptDraftsFromStorage,
} from './promptDraftPersistence.js'
import {
  SIDEBAR_WIDTH_STORAGE_KEY,
  readSidebarWidthFromStorage,
} from './sidebarWidth.js'
import {
  SIDEBAR_PINNED_SESSIONS_STORAGE_KEY,
  readPinnedSessionsFromStorage,
} from './sidebarPinnedSessions.js'
import {
  SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY,
  readWorkspaceOrderFromStorage,
} from './sidebarWorkspaceOrder.js'
import {
  SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY,
  readHiddenWorkspacesFromStorage,
} from './sidebarHiddenWorkspaces.js'
import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'
import { memoryStorage as storage } from './viewPreferenceStorageFixture.js'

test('every preference still reads the record shape already on disk', () => {
  expect(
    readAccentFromStorage(
      storage({ [ACCENT_STORAGE_KEY]: '{"version":1,"accent":"blue"}' }),
    ),
  ).toBe('blue')
  expect(
    readCodeThemeFromStorage(
      storage({ [CODE_THEME_STORAGE_KEY]: '{"version":1,"theme":"nord"}' }),
    ),
  ).toBe('nord')
  expect(
    readColorSchemeFromStorage(
      storage({ [COLOR_SCHEME_STORAGE_KEY]: '{"version":1,"scheme":"light"}' }),
    ),
  ).toBe('light')
  expect(
    readGlassFromStorage(
      storage({ [GLASS_STORAGE_KEY]: '{"version":1,"enabled":true}' }),
    ),
  ).toBe(true)
  expect(
    readProseArrivalFromStorage(
      storage({
        [PROSE_ARRIVAL_STORAGE_KEY]: '{"version":1,"arrival":"flowing"}',
      }),
    ),
  ).toBe('flowing')
  expect(
    readReasoningLayoutFromStorage(
      storage({
        [REASONING_LAYOUT_STORAGE_KEY]: '{"version":1,"mode":"blocks"}',
      }),
    ),
  ).toBe('blocks')
  expect(
    readToolCardStyleFromStorage(
      storage({ [TOOL_CARD_STYLE_STORAGE_KEY]: '{"version":1,"style":"lines"}' }),
    ),
  ).toBe('lines')
  expect(
    readToolsExpandedFromStorage(
      storage({ [TOOLS_EXPANDED_STORAGE_KEY]: '{"version":1,"expanded":true}' }),
    ),
  ).toBe(true)
  expect(
    readSidebarWidthFromStorage(
      storage({ [SIDEBAR_WIDTH_STORAGE_KEY]: '{"version":1,"width":312}' }),
    ),
  ).toBe(312)
  expect(
    readPromptDraftsFromStorage(
      storage({
        [PROMPT_DRAFTS_STORAGE_KEY]: '{"version":1,"drafts":{"s-1":"half a "}}',
      }),
    ),
  ).toEqual({ 's-1': 'half a ' })
  expect(
    readPinnedSessionsFromStorage(
      storage({
        [SIDEBAR_PINNED_SESSIONS_STORAGE_KEY]:
          '{"version":1,"sessionIds":["a","b"]}',
      }),
    ),
  ).toEqual(['a', 'b'])
  expect(
    readWorkspaceOrderFromStorage(
      storage({
        [SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY]:
          '{"version":1,"cwds":["/x","/y"]}',
      }),
    ),
  ).toEqual(['/x', '/y'])
  expect(
    readHiddenWorkspacesFromStorage(
      storage({
        [SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY]:
          '{"version":1,"workspaces":[{"cwd":"/x","hiddenAt":17}]}',
      }),
    ),
  ).toEqual([{ cwd: '/x', hiddenAt: 17 }])
})

test('a write still produces that same record, byte for byte', () => {
  const store = storage()
  writeAccentToStorage(store, 'amber')
  expect(store.map.get(ACCENT_STORAGE_KEY)).toBe('{"version":1,"accent":"amber"}')
})

test('anything that is not a version-1 object reads as nothing stored', () => {
  const accept = (value: unknown) => (typeof value === 'string' ? value : null)
  const read = (raw: string) =>
    readViewPreference(storage({ k: raw }), 'k', 'f', accept)
  expect(read('{"version":1,"f":"kept"}')).toBe('kept')
  expect(read('not json')).toBeNull()
  expect(read('null')).toBeNull()
  expect(read('7')).toBeNull()
  expect(read('"a string"')).toBeNull()
  expect(read('["f"]')).toBeNull()
  expect(read('{"version":2,"f":"kept"}')).toBeNull()
  expect(read('{"f":"kept"}')).toBeNull()
  expect(read('{"version":1}')).toBeNull()
  expect(readViewPreference(null, 'k', 'f', accept)).toBeNull()
})

test('a storage that throws is survivable on both halves', () => {
  const hostile: ViewPreferenceStorage = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('quota')
    },
  }
  expect(readViewPreference(hostile, 'k', 'f', () => 'x')).toBeNull()
  expect(() => writeViewPreference(hostile, 'k', 'f', 'x')).not.toThrow()
  expect(() => writeViewPreference(null, 'k', 'f', 'x')).not.toThrow()
})
