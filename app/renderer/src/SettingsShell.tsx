/**
 * Settings shell (P4-3) — the two-pane Settings frame from the prototype's
 * `Settings.jsx` (left category rail + dense right pane), rebuilt in TS/Tailwind
 * on the P0-2 tokens. This session ships the SHELL + the `Field`/`SourceBadge`/
 * `ManagedBadge` primitives over the real settings source/precedence model; the
 * value-editing panels plug in later (P4-12 → `SettingsExtensions`, etc.).
 *
 * The read-seam is `settings.snapshot` (P4-3, `settingsState.ts`): the source/
 * editable/managed model, no values. So the panels that are pure value editors
 * are honest stubs here (the prototype uses the same `StubPanel` idiom); the
 * MANAGED panel and the resolution legend/layer summary render REAL snapshot
 * data — the primitives demonstrated over engine truth, not fixtures.
 *
 * The category rail is grouped by SCOPE (see `SETTINGS_CATEGORIES` /
 * `CAT_SCOPE`), not by the prototype's functional headings, because the screen
 * mixes settings that are identical on every machine with settings that
 * silently describe whichever session is focused, and nothing on screen told
 * the operator which was which.
 */

import { useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AgentConfigSnapshot,
  DiagnosticsSnapshot,
  ExtensionsSnapshot,
  MemorySnapshot,
  PermissionContextSnapshot,
  RemoteSettingsResultFrame,
  RemoteSettingsSnapshot,
  RemoteVerbMessage,
  SettingsSnapshot,
  WorkspaceTrustSnapshot,
} from '../../shared/protocol.js'
import { AgentsPage } from './AgentsPage.js'
import { DiagnosticsSection } from './DiagnosticsSection.js'
import { MemoryPage } from './MemoryPage.js'
import { PermissionRulesEditor } from './PermissionRulesEditor.js'
import {
  isReasoningLayoutMode,
  ReasoningLayoutContext,
  REASONING_LAYOUT_MODES,
  REASONING_LAYOUT_LABELS,
} from './reasoningLayout.js'
import { RemoteSettingsPage } from './RemoteSettingsPage.js'
import { SelectControl, SettingsPane } from './SettingsEditors.js'
import type { SettingWriteInput } from './SettingsEditors.js'
import {
  SETTINGS_PROJECT_UNBOUND_NOTE,
  type SettingsProjectBinding,
} from './settingsProjectBinding.js'
import {
  SETTINGS_UNREAD_NOTE,
  settingsWereRead,
} from './settingsReadState.js'
import {
  HooksPanel,
  McpPanel,
  PluginsPanel,
  SkillsPanel,
} from './SettingsExtensions.js'
import {
  Field,
  LockIcon,
  PaneSection,
  ResolutionOrderLegend,
  SourceBadge,
} from './SettingsField.js'
import {
  selectLayerOrigin,
  selectManagedFields,
  selectPermissionDefaultMode,
  SETTING_SOURCE_PRECEDENCE,
} from './settingsState.js'
import { WorkspaceTrustSection } from './WorkspaceTrustSection.js'

type NavItem = { id: string; label: string; locked?: boolean }

/**
 * What the open project can do to a category's values.
 *
 *  - `machine` — no project layer exists anywhere in the resolver, so the values
 *    are the same whatever session is focused.
 *  - `project` — every field is cwd/session-derived; nothing global is inside.
 *  - `resolved` — your user config with the open project's layers stacked on
 *    top, per row.
 *
 * The three-way split is the point: a heading may say *"depends on the open
 * project"*, which is a possibility claim the `SourceBadge` on each row then
 * repairs into the exact answer, but it may NOT say *"applies everywhere"* about
 * a category a project layer can override — that is a universal claim, and no
 * per-row badge can repair a heading that already promised it. So a category
 * whose scope is uncertain belongs in `resolved`, the weaker claim.
 */
type SettingsScope = 'resolved' | 'project' | 'machine'

type NavGroup = {
  scope: SettingsScope
  heading: string
  /** Why no project could be named. Rendered only under the heading that would
   * otherwise have named one. */
  note?: string
  /** The bound project's cwd — its identity, behind the truncated label. */
  cwd?: string
  items: readonly NavItem[]
}

/**
 * Category rail, ported from the prototype's `SETTINGS_NAV` minus the CUT groups
 * (the `Prototype` demo group and `native`, both dropped — INVENTORY CUT list /
 * Settings.jsx note). Several bodies are still P4-x stubs.
 *
 * Kept as ONE ordered list because scope, not function, now groups the rail: the
 * prototype's `Interface`/`Extensions`/`System`/`Organization` headings are
 * subordinated (an operator-approved deviation from prototype parity), and this
 * order is what survives of them — each category keeps its relative position
 * inside whichever scope group it lands in, so the rail reads the way it did.
 */
const SETTINGS_CATEGORIES = [
  { id: 'general', label: 'General' },
  { id: 'model', label: 'Model & Inference' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'memory', label: 'Memory' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'keybindings', label: 'Keybindings' },
  { id: 'theme', label: 'Theme & Output' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'agents', label: 'Agents' },
  { id: 'mcp', label: 'MCP' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'skills', label: 'Skills' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'ide', label: 'IDE & LSP' },
  { id: 'remote', label: 'Remote' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'managed', label: 'Managed', locked: true },
] as const satisfies readonly NavItem[]

type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id']

/**
 * Every category's scope, from a source-level read of each pane's resolver (not
 * from its heading, which is what made the mixture invisible in the first
 * place). A `Record` over the id union, so adding a category without deciding
 * its scope is a compile error rather than a silent drop out of the rail.
 *
 * `ide` is the one JUDGEMENT call: it is an unbuilt stub with no read-seam, so
 * its scope is genuinely unknown. It sits in `resolved` because that is the
 * claim that cannot be falsified by whatever seam it eventually grows — a
 * machine-wide IDE setting is simply one the project layers never override.
 * Re-decide it when the seam lands.
 */
const CAT_SCOPE: Record<SettingsCategoryId, SettingsScope> = {
  general: 'resolved',
  model: 'resolved',
  permissions: 'resolved',
  workspace: 'project',
  memory: 'resolved',
  privacy: 'resolved',
  keybindings: 'machine',
  theme: 'resolved',
  transcript: 'machine',
  agents: 'resolved',
  mcp: 'resolved',
  plugins: 'resolved',
  skills: 'resolved',
  hooks: 'resolved',
  ide: 'resolved',
  remote: 'project',
  diagnostics: 'resolved',
  managed: 'machine',
}

/**
 * Rail order. `resolved` leads because it holds 13 of the 18 categories and
 * because `general` — the pane the screen opens on — is inside it; putting the
 * two small scopes first would push the whole familiar rail down the screen for
 * no navigational gain.
 */
const SCOPE_ORDER: readonly SettingsScope[] = ['resolved', 'project', 'machine']

/**
 * The heading for one scope group.
 *
 * Only `resolved` names the project, and only when one is bound. Unbound it
 * falls back to a statement about HOW these settings resolve rather than a
 * placeholder name or an empty heading — the `settingsReadState.ts` rule
 * (nothing is in flight, so nothing may promise a resolution) applied to the
 * other fact this surface silently assumes.
 */
function scopeHeading(
  scope: SettingsScope,
  binding: SettingsProjectBinding,
): string {
  switch (scope) {
    case 'machine':
      return 'This machine'
    case 'project':
      return 'This project'
    case 'resolved':
      return binding.bound
        ? `Resolved for ${binding.name}`
        : 'Resolved per project'
    default: {
      const exhaustive: never = scope
      return exhaustive
    }
  }
}

/**
 * The rail: every category placed in its scope group and matched against the
 * search box, in one pure pass.
 *
 * Exported because the search box is the one part of this shell the SSR-only
 * renderer suite cannot drive (no events), and a filter that quietly stopped
 * reaching the third group would look identical in the markup to one that
 * worked. Groups emptied by the query drop out entirely — heading, note and all
 * — so no heading is left standing over nothing.
 */
export function selectSettingsNavGroups(
  binding: SettingsProjectBinding,
  query: string,
): NavGroup[] {
  const q = query.trim().toLowerCase()
  return SCOPE_ORDER.map(scope => ({
    scope,
    heading: scopeHeading(scope, binding),
    note:
      scope === 'resolved' && !binding.bound
        ? SETTINGS_PROJECT_UNBOUND_NOTE[binding.reason]
        : undefined,
    cwd: scope === 'resolved' && binding.bound ? binding.cwd : undefined,
    items: SETTINGS_CATEGORIES.filter(
      item =>
        CAT_SCOPE[item.id] === scope &&
        (!q || item.label.toLowerCase().includes(q)),
    ),
  })).filter(group => group.items.length > 0)
}

/**
 * Until `App.tsx` passes `selectSettingsProjectBinding(rows, activeSessionId)`
 * — a one-line change, deliberately left out of this commit because App is
 * mid-edit in another session — the shell names no project. The default is the
 * resting state of a launched app with every tab closed, which is also the state
 * every test that omits the prop is exercising.
 */
const UNBOUND_PROJECT: SettingsProjectBinding = {
  bound: false,
  reason: 'no-session',
}

const CAT_DESC: Record<string, string> = {
  general: 'Identity, editor, startup, and update behavior',
  model: 'Default model, reasoning effort, and thinking',
  permissions: 'Default mode and tool allow / deny rules',
  workspace: 'Trust state and accessible directories',
  memory: 'CLAUDE.md instruction files and saved memories',
  privacy: 'Retention, sharing, and crash reporting',
  keybindings: 'Composer mode and keyboard shortcuts',
  theme: 'Accent, syntax highlighting, and output style',
  transcript: 'How this app lays out reasoning in the transcript',
  agents: 'Agent definitions by source, with overrides and precedence',
  mcp: 'Connected Model Context Protocol servers',
  plugins: 'Installed plugins and the marketplace',
  skills: 'Prompt-command skills, grouped by source',
  hooks: 'Event hooks by event, with recent run results',
  ide: 'Editor connection and language servers',
  remote: 'Remote Control bridge and connect transports',
  diagnostics: 'Doctor and status checks',
  managed: 'Settings enforced by organization policy',
}

/** Which later Phase-4 session fills each stubbed category (honesty, not a mock). */
const CAT_OWNER: Record<string, string> = {
  general: 'a later Phase-4 settings session',
  model: 'a later Phase-4 settings session',
  memory: 'Goals + Memory (P4-10)',
  privacy: 'a later Phase-4 settings session',
  keybindings: 'a later Phase-4 settings session',
  theme: 'a later Phase-4 settings session',
  agents: 'Agents config (P4-7)',
  mcp: 'Settings extensions (P4-12)',
  plugins: 'Settings extensions (P4-12)',
  skills: 'Settings extensions (P4-12)',
  hooks: 'Settings extensions (P4-12)',
  ide: 'a later Phase-4 settings session',
}

export function SettingsShell({
  snapshot,
  additionalWorkingDirectories,
  permissionContext,
  agentsSnapshot,
  cwd,
  diagnosticsSnapshot,
  memorySnapshot,
  workspaceTrustSnapshot,
  extensionsSnapshot,
  remoteSnapshot,
  remoteLastResult,
  onRemoteVerb,
  onSettingWrite,
  projectBinding = UNBOUND_PROJECT,
  initialCategory = 'general',
}: {
  snapshot: SettingsSnapshot | null
  /** C3 — reused from `permission.context`, not a second seam (§10). */
  additionalWorkingDirectories?: PermissionContextSnapshot['additionalWorkingDirectories']
  /** C3 — the active session's live permission context. Feeds ONLY the
   * session-derived half of the Permissions pane (effective rules, this
   * session's mode, managed-policy + classifier state), which is engine-resolved
   * per session and has no global equivalent. The pane's settings-backed
   * "Default mode" section reads `snapshot` instead, so it renders with no
   * session attached (CC-13). Same `permission.context` snapshot the composer
   * mode chip reads — no second seam. */
  permissionContext?: PermissionContextSnapshot | null
  agentsSnapshot?: AgentConfigSnapshot | null
  /** The active session's cwd (already known via the host roster; not re-plumbed). */
  cwd?: string | null
  diagnosticsSnapshot?: DiagnosticsSnapshot | null
  memorySnapshot?: MemorySnapshot | null
  workspaceTrustSnapshot?: WorkspaceTrustSnapshot | null
  extensionsSnapshot?: ExtensionsSnapshot | null
  remoteSnapshot?: RemoteSettingsSnapshot | null
  remoteLastResult?: RemoteSettingsResultFrame | null
  onRemoteVerb?: (verb: RemoteVerbMessage) => void
  /** P4-19 — send one editable-setting write to the sidecar. */
  onSettingWrite?: (input: SettingWriteInput) => void
  /** Which project this screen is describing (`settingsProjectBinding.ts`).
   * Optional so App can wire `selectSettingsProjectBinding(rows,
   * activeSessionId)` in one line later; the default names nothing. */
  projectBinding?: SettingsProjectBinding
  initialCategory?: string
}) {
  const [active, setActive] = useState(initialCategory)
  const [query, setQuery] = useState('')

  const filteredNav = selectSettingsNavGroups(projectBinding, query)
  const activeItem = SETTINGS_CATEGORIES.find(item => item.id === active)

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden" aria-label="Settings">
      {/* Left rail */}
      <nav className="w-[224px] shrink-0 overflow-y-auto border-r border-shell-seam bg-shell-chrome px-3 py-5">
        <div className="mb-4 px-2">
          <h1 className="text-base font-semibold tracking-tight text-text-primary">
            Settings
          </h1>
        </div>
        <input
          aria-label="Search settings"
          className="mb-4 w-full rounded-lg border border-shell-seam bg-shell-hover px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none placeholder:text-text-subtle"
          onChange={event => setQuery(event.target.value)}
          placeholder="Search settings"
          value={query}
        />
        {filteredNav.map(group => (
          <div
            aria-label={group.heading}
            className="mb-3"
            key={group.scope}
            role="group"
          >
            <div
              className="mb-1.5 truncate px-2 text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-subtle"
              title={group.cwd}
            >
              {group.heading}
            </div>
            {group.note ? (
              <p className="mb-1.5 px-2 text-[10.5px] leading-relaxed text-text-subtle">
                {group.note}
              </p>
            ) : null}
            <div className="flex flex-col gap-px">
              {group.items.map(item => {
                const on = item.id === active
                return (
                  <button
                    aria-current={on ? 'page' : undefined}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                      on
                        ? 'bg-accent/10 font-semibold text-accent-soft'
                        : 'text-text-muted hover:bg-shell-hover'
                    }`}
                    key={item.id}
                    onClick={() => setActive(item.id)}
                    type="button"
                  >
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.locked ? (
                      <LockIcon
                        className={on ? 'h-2.5 w-2.5 text-accent-soft' : 'h-2.5 w-2.5 text-text-subtle'}
                      />
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        {filteredNav.length === 0 ? (
          <div className="px-2 text-xs text-text-subtle">No matches</div>
        ) : null}
      </nav>

      {/* Right pane */}
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto max-w-[660px]">
          <header className="mb-5">
            <h2 className="text-lg font-semibold tracking-tight text-text-primary">
              {activeItem?.label ?? 'Settings'}
            </h2>
            <p className="text-[13px] text-text-subtle">{CAT_DESC[active]}</p>
          </header>
          <CategoryBody
            additionalWorkingDirectories={additionalWorkingDirectories ?? []}
            permissionContext={permissionContext ?? null}
            agentsSnapshot={agentsSnapshot ?? null}
            category={active}
            cwd={cwd ?? null}
            diagnosticsSnapshot={diagnosticsSnapshot ?? null}
            extensionsSnapshot={extensionsSnapshot ?? null}
            memorySnapshot={memorySnapshot ?? null}
            onRemoteVerb={onRemoteVerb ?? (() => {})}
            onSettingWrite={onSettingWrite ?? (() => {})}
            remoteLastResult={remoteLastResult ?? null}
            remoteSnapshot={remoteSnapshot ?? null}
            snapshot={snapshot}
            workspaceTrustSnapshot={workspaceTrustSnapshot ?? null}
          />
        </div>
      </div>
    </div>
  )
}

function CategoryBody({
  additionalWorkingDirectories,
  permissionContext,
  agentsSnapshot,
  category,
  cwd,
  diagnosticsSnapshot,
  extensionsSnapshot,
  memorySnapshot,
  onRemoteVerb,
  onSettingWrite,
  remoteLastResult,
  remoteSnapshot,
  snapshot,
  workspaceTrustSnapshot,
}: {
  additionalWorkingDirectories: PermissionContextSnapshot['additionalWorkingDirectories']
  permissionContext: PermissionContextSnapshot | null
  agentsSnapshot: AgentConfigSnapshot | null
  category: string
  cwd: string | null
  diagnosticsSnapshot: DiagnosticsSnapshot | null
  extensionsSnapshot: ExtensionsSnapshot | null
  memorySnapshot: MemorySnapshot | null
  onRemoteVerb: (verb: RemoteVerbMessage) => void
  onSettingWrite: (input: SettingWriteInput) => void
  remoteLastResult: RemoteSettingsResultFrame | null
  remoteSnapshot: RemoteSettingsSnapshot | null
  snapshot: SettingsSnapshot | null
  workspaceTrustSnapshot: WorkspaceTrustSnapshot | null
}) {
  if (category === 'agents') {
    return <AgentsPage embedded snapshot={agentsSnapshot} />
  }
  if (category === 'memory') {
    return <MemoryPage embedded snapshot={memorySnapshot} />
  }
  if (category === 'mcp') {
    return <McpPanel snapshot={extensionsSnapshot} />
  }
  if (category === 'plugins') {
    return <PluginsPanel snapshot={extensionsSnapshot} />
  }
  if (category === 'skills') {
    return <SkillsPanel snapshot={extensionsSnapshot} />
  }
  if (category === 'hooks') {
    return <HooksPanel snapshot={extensionsSnapshot} />
  }
  if (category === 'remote') {
    return (
      <RemoteSettingsPage
        embedded
        lastResult={remoteLastResult}
        onVerb={onRemoteVerb}
        snapshot={remoteSnapshot}
      />
    )
  }
  if (category === 'managed') {
    return <ManagedPanel snapshot={snapshot} />
  }
  if (category === 'permissions') {
    // P2-4 C3 read-only rules view (PERMISSION-BOUNDARY.md §4, ledger row 787).
    // `showModes={false}`: the renderer never authors rules (T6b) and mode
    // switching lives on the composer `PermissionModeChip` — this pane is a
    // pure read-only display, so `onSetMode` is never invoked (the mode buttons
    // are not rendered).
    // CC-13 — `defaultMode` comes off the SETTINGS seam, not the session's live
    // context, so the "Default mode" section shows the persisted setting and
    // renders with no session attached.
    return (
      <PaneSection title="Permissions">
        <PermissionRulesEditor
          context={permissionContext}
          defaultMode={selectPermissionDefaultMode(snapshot)}
          onSetMode={() => {}}
          // No snapshot ⇒ no settings file has been read, so a null defaultMode
          // is UNKNOWN rather than unset (`settingsReadState.ts` — the one rule
          // this whole surface branches on).
          settingsLoaded={settingsWereRead(snapshot)}
          showModes={false}
        />
      </PaneSection>
    )
  }
  if (category === 'workspace') {
    return (
      <WorkspaceTrustSection
        additionalWorkingDirectories={additionalWorkingDirectories}
        cwd={cwd}
        snapshot={workspaceTrustSnapshot}
      />
    )
  }
  if (category === 'transcript') {
    return <TranscriptDisplaySection />
  }
  if (category === 'diagnostics') {
    return <DiagnosticsSection settingsSnapshot={snapshot} snapshot={diagnosticsSnapshot} />
  }
  if (category === 'general') {
    // Real read-seam data (layer summary + resolution legend) above the live
    // General value-editors (P4-19).
    return (
      <>
        <PaneSection title="Configuration sources">
          <LayerSummary snapshot={snapshot} />
          <ResolutionOrderLegend />
        </PaneSection>
        <SettingsPane
          onWrite={onSettingWrite}
          pane="general"
          snapshot={snapshot}
          title="General"
        />
      </>
    )
  }
  if (category === 'model') {
    return (
      <>
        <SettingsPane
          onWrite={onSettingWrite}
          pane="model"
          snapshot={snapshot}
          title="Model & inference"
        />
        <DeferredEditorsNote note="Default-model select is deferred (needs the model-list read-seam)." />
      </>
    )
  }
  if (category === 'privacy') {
    return (
      <>
        <SettingsPane
          onWrite={onSettingWrite}
          pane="privacy"
          snapshot={snapshot}
          title="Privacy"
        />
        <DeferredEditorsNote note="Share-session-data and crash-reporting have no engine setting today; deferred." />
      </>
    )
  }
  if (category === 'theme') {
    return (
      <>
        <SettingsPane
          onWrite={onSettingWrite}
          pane="theme"
          snapshot={snapshot}
          title="Theme & output"
        />
        <DeferredEditorsNote note="Accent swatch, code theme/font, and output-style select are deferred (need theming / available-styles seams)." />
      </>
    )
  }
  return <CategoryStub category={category} />
}

/**
 * The one APP-LOCAL editor in this shell: how the transcript renders reasoning
 * summaries (`reasoningLayout.ts`). It carries no `SourceBadge` because it has
 * no settings layer — it is a renderer view preference stored with the workspace
 * layout, not a `SettingsSchema` key the sidecar writes, and the description
 * says so rather than letting it read as an engine setting that failed to
 * resolve. Reads and writes the same context the transcript reads.
 *
 * Its own category under `This machine`, not a section of `Theme & Output`,
 * where it used to sit: having no settings layer at all, it is the one control
 * on this screen that genuinely cannot vary by project, and it was the only such
 * control filed under a heading that promised the opposite.
 */
function TranscriptDisplaySection() {
  const { mode, setMode } = useContext(ReasoningLayoutContext)
  return (
    <PaneSection title="Reasoning">
      <Field
        desc="How reasoning summaries are laid out in the transcript. Which reasoning is shown at all is the engine's separate “Reasoning display” setting under Model &amp; Inference. Stored in this app, not in your settings files."
        label="Reasoning layout"
      >
        <SelectControl
          label="Reasoning layout"
          onChange={next => {
            if (isReasoningLayoutMode(next)) setMode(next)
          }}
          optionLabels={REASONING_LAYOUT_LABELS}
          options={REASONING_LAYOUT_MODES}
          value={mode}
        />
      </Field>
    </PaneSection>
  )
}

function LayerSummary({ snapshot }: { snapshot: SettingsSnapshot | null }) {
  if (!snapshot) {
    return (
      <p className="text-[12.5px] text-text-subtle">
        Waiting for the engine's settings snapshot…
      </p>
    )
  }
  if (snapshot.layers.length === 0) {
    return (
      <p className="text-[12.5px] text-text-subtle">
        No settings files on disk — every value is at its built-in default.
      </p>
    )
  }
  // Highest-precedence first, matching the legend below.
  const ordered = [...snapshot.layers].sort(
    (a, b) =>
      SETTING_SOURCE_PRECEDENCE.indexOf(a.source) -
      SETTING_SOURCE_PRECEDENCE.indexOf(b.source),
  )
  return (
    <div className="flex flex-col gap-1.5">
      {ordered.map(layer => (
        <div className="flex items-center gap-2 text-[12px]" key={layer.source}>
          <SourceBadge origin={layer.origin} source={layer.source} />
          <span className="truncate font-mono text-[11px] text-text-subtle">
            {layer.origin}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-text-muted">
            {layer.keys.length} {layer.keys.length === 1 ? 'key' : 'keys'}
          </span>
        </div>
      ))}
    </div>
  )
}

function ManagedPanel({ snapshot }: { snapshot: SettingsSnapshot | null }) {
  const managed = selectManagedFields(snapshot)
  const policyOrigin = snapshot?.policyOrigin ?? null
  const layerOrigin = selectLayerOrigin(snapshot, 'policySettings')
  return (
    <>
      <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-source-policy/25 bg-source-policy/5 px-4 py-3">
        <span className="mt-px shrink-0 text-source-policy">
          <LockIcon className="h-[15px] w-[15px]" />
        </span>
        <div>
          <div className="text-[13px] font-semibold text-source-policy">
            Managed by your organization
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
            These settings are enforced by policy and cannot be changed locally.
            They always override user, project, and local configuration.
          </p>
          {policyOrigin ? (
            <code className="mt-1.5 inline-block font-mono text-[11px] text-text-subtle">
              policy source: {policyOrigin}
              {layerOrigin ? ` · ${layerOrigin}` : ''}
            </code>
          ) : null}
        </div>
      </div>
      <PaneSection title="Enforced settings">
        {/* "Nothing is enforced" is a claim about org policy, and this is the
         * pane an operator checks to find that out. It may only be made from a
         * snapshot that was actually read — see `settingsReadState.ts`. */}
        {!settingsWereRead(snapshot) ? (
          <p className="text-[12.5px] text-text-subtle">
            {SETTINGS_UNREAD_NOTE} Whether your organization enforces any
            settings is <span className="font-mono">unknown</span> until then.
          </p>
        ) : managed.length === 0 ? (
          <p className="text-[12.5px] text-text-subtle">
            No managed settings on this machine.
          </p>
        ) : (
          managed.map(field => (
            <Field key={field.key} label={field.key} managed origin={layerOrigin}>
              <span className="font-mono text-[12.5px] text-text-muted">
                enforced
              </span>
            </Field>
          ))
        )}
      </PaneSection>
    </>
  )
}

/** An honest footnote naming the value-editors still deferred for a pane. */
function DeferredEditorsNote({ note }: { note: string }) {
  return (
    <p className="mt-4 text-[11.5px] leading-relaxed text-text-subtle">{note}</p>
  )
}

function CategoryStub({ category }: { category: string }) {
  return (
    <StubPanel
      note={`This panel's value editors land in ${
        CAT_OWNER[category] ?? 'a later Phase-4 session'
      }. The source-badge model and the Field primitives it plugs into are ready.`}
      title={`${CAT_DESC[category] ? CAT_DESC[category] : 'Settings'} — coming soon`}
    />
  )
}

function StubPanel({ title, note }: { title: string; note: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/40 px-8 py-10 text-center">
      <div className="mx-auto mb-3.5 flex h-10 w-10 items-center justify-center rounded-xl bg-shell-hover text-text-subtle">
        <LockIcon className="h-4 w-4" />
      </div>
      <div className="mb-1.5 text-sm font-semibold text-text-muted">{title}</div>
      <div className="mx-auto max-w-[360px] text-[12.5px] leading-relaxed text-text-subtle">
        {note}
      </div>
    </div>
  )
}
