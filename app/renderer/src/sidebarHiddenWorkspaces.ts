/**
 * Sidebar HIDDEN workspaces — the operator's way to take a project group OFF the
 * left rail. Operator request, 2026-08-02: the Projects header can ADD a project
 * but nothing could remove one.
 *
 * A project is DERIVED, not stored: `groupByWorkspace` (`sessionsCatalogState.ts`)
 * buckets the merged roster by `cwd`, and "Add project" only opens a folder
 * picker — the session created there is what makes the group appear. There is no
 * empty-workspace record to delete, so the mirror of Add is a VIEW hide, not a
 * delete: the sessions stay on disk and on the Sessions page (which lists
 * everything), exactly the non-destructive shape `isSidebarVisibleRow` already
 * uses for dead-workspace rows (`sidebarState.ts:285`).
 *
 * Keyed on `cwd`, NEVER on the rendered label — `disambiguateWorkspaceLabels`
 * rewrites a label the moment a second workspace shares its basename
 * (`sidebarWorkspaceOrder.ts:18`), so a label key would hide the wrong group.
 *
 * SELF-HEALING, and this is the load-bearing part. Hiding is remembered with the
 * moment it happened, and the entry stops applying once that project has
 * activity newer than it. Without this, hiding a project and then picking that
 * same folder from "Add project" would create a session into an invisible group:
 * the picker would look broken. Any real work in a hidden project brings it
 * back, which is also the honest answer to "where did my session go".
 *
 * Renderer-local persistence, the `sidebarPinnedSessions.ts` idiom verbatim:
 * versioned JSON under a `catcode.`-prefixed key, read/written through an
 * injectable `Pick<Storage, …>`, best-effort. No protocol frame, no registry
 * field, no preload channel — a view preference with no engine meaning
 * (SECURITY-MINIMUM §2).
 */

export const SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY =
  'catcode.sidebarHiddenWorkspaces.v1'

/**
 * Persistence bound. Entries deliberately OUTLIVE the roster (a hidden project
 * whose transcripts have not been enumerated yet must stay hidden), so without a
 * cap the list would grow for the life of the install. The tail is the
 * oldest-hidden end, so truncating there costs least.
 */
export const MAX_SIDEBAR_HIDDEN_WORKSPACES = 64

/** One hidden project: its workspace path, and when it was hidden. */
export type HiddenWorkspace = {
  cwd: string
  /** Epoch ms. Activity newer than this un-hides the group (see the header). */
  hiddenAt: number
}

/** Hidden projects, most-recently-hidden first. */
export type HiddenWorkspaces = readonly HiddenWorkspace[]

type HiddenStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedHiddenWorkspaces = {
  version: 1
  workspaces: HiddenWorkspace[]
}

export function createHiddenWorkspaces(): HiddenWorkspaces {
  return []
}

/**
 * A cwd that can be hidden. The "Unknown workspace" bucket (`cwd === ''`) is
 * excluded for the same reasons it cannot be reordered
 * (`sidebarWorkspaceOrder.ts:71`): it is not a workspace but a catch-all whose
 * membership churns, and `''` is a fragile persisted key.
 */
function isHideableCwd(cwd: string): boolean {
  return cwd.trim().length > 0
}

/** Drop blanks and duplicates, preserving first-seen order. */
function dedupeWorkspaces(
  values: readonly HiddenWorkspace[],
): HiddenWorkspace[] {
  const seen = new Set<string>()
  const out: HiddenWorkspace[] = []
  for (const entry of values) {
    if (!isHideableCwd(entry.cwd) || seen.has(entry.cwd)) continue
    seen.add(entry.cwd)
    out.push(entry)
  }
  return out
}

/** Storage-boundary normalization: well-formed entries only, deduped, capped. */
function normalizeHiddenWorkspaces(
  values: readonly unknown[],
): HiddenWorkspace[] {
  const entries = values.filter((value): value is HiddenWorkspace => {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Partial<HiddenWorkspace>
    return (
      typeof candidate.cwd === 'string' &&
      typeof candidate.hiddenAt === 'number' &&
      Number.isFinite(candidate.hiddenAt)
    )
  })
  return dedupeWorkspaces(entries).slice(0, MAX_SIDEBAR_HIDDEN_WORKSPACES)
}

export function readHiddenWorkspacesFromStorage(
  storage: HiddenStorage | null,
): HiddenWorkspaces | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedHiddenWorkspaces>
    if (value.version !== 1 || !Array.isArray(value.workspaces)) return null
    return normalizeHiddenWorkspaces(value.workspaces)
  } catch {
    return null
  }
}

export function writeHiddenWorkspacesToStorage(
  storage: HiddenStorage | null,
  hidden: HiddenWorkspaces,
): void {
  if (!storage) return
  try {
    const value: PersistedHiddenWorkspaces = {
      version: 1,
      workspaces: normalizeHiddenWorkspaces(hidden),
    }
    storage.setItem(
      SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY,
      JSON.stringify(value),
    )
  } catch {
    // View persistence is best-effort; a storage failure must never affect live
    // session state (`sidebarWorkspaceOrder.ts:133`).
  }
}

/**
 * Hide one project, as of `hiddenAt`. Re-hiding a project already in the list
 * REFRESHES its moment — that is what makes hiding work a second time after the
 * group came back on its own. The newest entry leads, so the cap drops the
 * oldest.
 *
 * Returns the SAME reference on a no-op so the caller can skip a state write.
 */
export function reduceWorkspaceHidden(
  hidden: HiddenWorkspaces,
  cwd: string,
  hiddenAt: number,
): HiddenWorkspaces {
  if (!isHideableCwd(cwd) || !Number.isFinite(hiddenAt)) return hidden
  return [{ cwd, hiddenAt }, ...hidden.filter(entry => entry.cwd !== cwd)]
}

/** Un-hide one project. Returns the SAME reference on a no-op. */
export function reduceWorkspaceShown(
  hidden: HiddenWorkspaces,
  cwd: string,
): HiddenWorkspaces {
  if (!hidden.some(entry => entry.cwd === cwd)) return hidden
  return hidden.filter(entry => entry.cwd !== cwd)
}

/** Un-hide everything. Returns the SAME reference on a no-op. */
export function reduceHiddenWorkspacesCleared(
  hidden: HiddenWorkspaces,
): HiddenWorkspaces {
  return hidden.length === 0 ? hidden : []
}

/**
 * Split the rendered group sequence into what the rail shows and what it is
 * holding back, preserving the caller's order in both.
 *
 * `activityOf` is how a group reports its most recent work — the sidebar passes
 * the CC-2 warp-free key (`sidebarActivityKey`), so opening or restoring a
 * session cannot resurrect a hidden project but sending a message can. Generic
 * over `{ cwd }` (the `selectPinnedRows` idiom) so this module needs no
 * `MergedSessionRow` import and is testable on bare fixtures.
 */
export function selectVisibleWorkspaceGroups<G extends { cwd: string }>(
  groups: readonly G[],
  hidden: HiddenWorkspaces,
  activityOf: (group: G) => number,
): { visible: G[]; hidden: G[] } {
  if (hidden.length === 0) return { visible: [...groups], hidden: [] }
  const hiddenAtByCwd = new Map(
    hidden.map(entry => [entry.cwd, entry.hiddenAt] as const),
  )
  const visible: G[] = []
  const held: G[] = []
  for (const group of groups) {
    const hiddenAt = hiddenAtByCwd.get(group.cwd)
    if (hiddenAt != null && activityOf(group) <= hiddenAt) {
      held.push(group)
    } else {
      visible.push(group)
    }
  }
  return { visible, hidden: held }
}
