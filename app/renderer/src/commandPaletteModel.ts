/**
 * CommandPalette model (P3-7) — the pure item catalog + fuzzy filter the ⌘K
 * palette renders. No React here so the action inventory and ranking are
 * unit-testable in isolation.
 *
 * Every item is a REAL action wired to an existing App handler or host-API call
 * (SECURITY-MINIMUM: the palette adds no capability — it only invokes the same
 * host methods the TabBar/Sidebar already expose). There are NO mocked entries
 * and NO dead rows: an action only appears when it can actually run in the
 * current shell state, and session rows come straight from the live ∪ restorable
 * roster (`selectShellDescriptors` — the same `SessionDescriptor` source the
 * Sidebar reads). Each row's status chip is derived from the shared
 * `sessionStatusVisual` (audit §I.2). Session search is a filter over those
 * rows' identity fields.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import { sessionStatusVisual } from './sessionStatusVisual.js'
import type { TabTone } from './tabStatus.js'
import { tabLabel } from './TabBar.js'

export type PaletteItemKind = 'action' | 'session'

export type PaletteItem = {
  id: string
  kind: PaletteItemKind
  /** Section header the item renders under ('Actions' | 'Sessions'). */
  group: string
  label: string
  /** Right-aligned context: a shortcut for actions, the cwd for sessions. */
  detail?: string
  /** Session status label (e.g. 'live', 'crashed'); drives the row's chip. */
  state?: string
  /** Session status tone for the dot/chip; absent for actions. */
  tone?: TabTone
  /** AX name: for sessions, identity + state (GUI-VERIFICATION honesty rule 3). */
  ariaLabel: string
  /** Extra searchable text (cwd, engine id, synonyms) folded into filtering. */
  keywords: string
  run: () => void
}

export type PaletteHandlers = {
  newSession: () => void
  closeActiveSession: () => void
  restartActiveSession: () => void
  copyActiveTranscript: () => void
  closeCurrentPanel: () => void
  selectLiveSession: (sessionId: SessionId) => void
  restoreSession: (sessionId: SessionId) => void
  openTasks: () => void
}

export type PaletteInput = {
  rows: SessionDescriptor[]
  activeSessionId: SessionId | null
  /** True when the workspace has at least one open panel (P3-6). */
  hasPanels: boolean
  handlers: PaletteHandlers
}

/**
 * Build the palette's action + session inventory for the current shell state.
 * Actions that need an active session (close/restart/copy) are omitted when
 * there is none; the panel action is omitted when no panel is open — so a
 * disabled/no-op row can never appear.
 */
export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const { rows, activeSessionId, hasPanels, handlers } = input
  const items: PaletteItem[] = []

  items.push({
    id: 'action:new-session',
    kind: 'action',
    group: 'Actions',
    label: 'New session',
    detail: '⌘T',
    ariaLabel: 'New session',
    keywords: 'create open tab new',
    run: handlers.newSession,
  })

  if (activeSessionId) {
    items.push({
      id: 'action:close-active',
      kind: 'action',
      group: 'Actions',
      label: 'Close active session',
      detail: '⌘W',
      ariaLabel: 'Close active session',
      keywords: 'close active tab',
      run: handlers.closeActiveSession,
    })
    items.push({
      id: 'action:restart-active',
      kind: 'action',
      group: 'Actions',
      label: 'Restart active session',
      ariaLabel: 'Restart active session',
      keywords: 'restart respawn reload active',
      run: handlers.restartActiveSession,
    })
    items.push({
      id: 'action:copy-active',
      kind: 'action',
      group: 'Actions',
      label: 'Copy active transcript for LLM',
      ariaLabel: 'Copy active transcript for LLM',
      keywords: 'copy transcript export clipboard llm',
      run: handlers.copyActiveTranscript,
    })
  }

  if (hasPanels) {
    items.push({
      id: 'action:close-panel',
      kind: 'action',
      group: 'Actions',
      label: 'Close current panel',
      ariaLabel: 'Close current panel',
      keywords: 'panel split layout close workspace',
      run: handlers.closeCurrentPanel,
    })
  }

  items.push({
    id: 'action:open-tasks',
    kind: 'action',
    group: 'Actions',
    label: 'Background tasks',
    ariaLabel: 'Background tasks',
    keywords: 'tasks background bash agent dream teammate workflow monitor /tasks',
    run: handlers.openTasks,
  })

  for (const descriptor of rows) {
    const id = descriptor.appSessionId
    const title = tabLabel(descriptor)
    const restorable = descriptor.restorable
    // Same status vocabulary the Sidebar/TabBar paint (audit §I.2). A palette
    // row is always a registry row, so `inRegistry` is true.
    const { label, tone } = sessionStatusVisual(descriptor.status, restorable, true)
    items.push({
      id: `session:${id}`,
      kind: 'session',
      group: 'Sessions',
      label: title,
      detail: descriptor.cwd,
      state: label,
      tone,
      ariaLabel: `session ${title} — ${label}${
        restorable ? ', restorable' : ''
      }`,
      keywords: `${descriptor.cwd} ${descriptor.engineSessionId ?? ''} ${label}`,
      // A restorable row re-spawns via restoreSession; a live row focuses its
      // tab — exactly the Sidebar's activate() split.
      run: () =>
        restorable
          ? handlers.restoreSession(id)
          : handlers.selectLiveSession(id),
    })
  }

  return items
}

/**
 * Filter + rank items for a query (case-insensitive substring over the label
 * and folded keywords). Ranking: label-prefix, then label-substring, then a
 * keyword-only match; ties keep the input order (Actions before Sessions,
 * recency within Sessions). An empty query returns everything unchanged.
 */
export function filterPaletteItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return items

  const ranked: Array<{ item: PaletteItem; rank: number; order: number }> = []
  items.forEach((item, order) => {
    const label = item.label.toLowerCase()
    if (label.startsWith(q)) {
      ranked.push({ item, rank: 0, order })
    } else if (label.includes(q)) {
      ranked.push({ item, rank: 1, order })
    } else if (`${label} ${item.keywords.toLowerCase()}`.includes(q)) {
      ranked.push({ item, rank: 2, order })
    }
  })

  return ranked
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.order - b.order))
    .map(entry => entry.item)
}
