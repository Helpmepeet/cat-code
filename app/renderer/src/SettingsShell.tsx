/**
 * Settings shell — rebuilt on `docs/migration/specs/2026-07-27-settings-redesign.md`
 * after the operator rejected the previous surface wholesale ("very bad in
 * grouping and everything… needs a full rebuild in philosophy").
 *
 * The old page displayed the RESOLVER's output: it bound silently to whichever
 * session was focused, so switching tabs changed what most panes meant, and it
 * showed a running session's permission mode under a heading ("Default mode")
 * that promised durable configuration. Both are one error — answering *"what did
 * the engine compute for whoever happens to be focused?"* where a Settings page
 * must answer *"what will happen next time, and for whom?"*.
 *
 * So this shell edits FILES, and its subject is CHOSEN:
 *
 *  - **Law 1 — Settings edits sources; sessions show state.** No live session
 *    value renders here. The live permission context, workspace trust, IDE/LSP
 *    status and doctor output moved to the session inspector (tab ⋯ → "Inspect
 *    metadata…", `MetadataInspector.tsx`), which already hosts every one of
 *    them — so this is a relocation, not a cut.
 *  - **Law 2 — Scope is chosen, never inherited.** The page head carries the
 *    subject: My defaults · a named Project · This app · Enforced. Switching
 *    session tabs never changes it. The focused session's project is offered
 *    FIRST and labeled "current", but selecting it is an act.
 *  - **Law 3 — Every write names its file before it happens.** The scope decides
 *    the write layer (`settingsScope.ts`); the pane states the destination path
 *    above the controls. `targetSourceFor` resolve-time targeting is deleted.
 *
 * The rail is FUNCTIONAL again — the resolver's five-way source taxonomy became
 * the scope selector plus a per-row annotation, and never structures the nav.
 *
 * v1 limits, stated on screen rather than papered over (spec §6): the settings
 * snapshot is one session's spawn-time read (`app/sidecar/settingsDomain.ts:16-17`),
 * so the user layer is trustworthy from any session while a PROJECT other than
 * the focused session's has not been read at all — and must not be written
 * either, since the write verb reaches that session's sidecar and would land in
 * its cwd's file. Scope-addressed reads (`settings.refresh`) are a later task.
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
import { MemoryPage } from './MemoryPage.js'
import {
  isReasoningLayoutMode,
  ReasoningLayoutContext,
  REASONING_LAYOUT_MODES,
  REASONING_LAYOUT_LABELS,
} from './reasoningLayout.js'
import { RemoteSettingsPage } from './RemoteSettingsPage.js'
import { SelectControl, SettingsPane } from './SettingsEditors.js'
import type { SettingWriteInput } from './SettingsEditors.js'
import type { SettingsProjectBinding } from './settingsProjectBinding.js'
import {
  SETTINGS_UNKNOWN_VALUE,
  SETTINGS_UNREAD_NOTE,
  settingsWereRead,
} from './settingsReadState.js'
import {
  SETTINGS_APPLY_NOTE,
  SETTINGS_PROJECT_LAYER_DESC,
  SETTINGS_PROJECT_LAYER_LABEL,
  SETTINGS_PROJECT_LAYERS,
  SETTINGS_SCOPE_KINDS,
  SETTINGS_SCOPE_LABEL,
  SETTINGS_SCOPE_SUBTITLE,
  SETTINGS_SESSION_STATE_NOTE,
  selectProjectEngine,
  selectSettingsProjects,
  selectSettingsRail,
  selectSettingsRailItem,
  selectSettingsWriteLayer,
  settingsNoEngineNote,
  settingsRailItem,
  type SettingsProjectEngine,
  type SettingsProjectLayer,
  type SettingsProjectOption,
  type SettingsRailItemId,
  type SettingsScopeKind,
} from './settingsScope.js'
import {
  HooksPanel,
  McpPanel,
  PluginsPanel,
  SkillsPanel,
} from './SettingsExtensions.js'
import { Field, LockIcon, PaneSection, SourceBadge } from './SettingsField.js'
import {
  selectLayerOrigin,
  selectManagedFields,
  selectPermissionDefaultMode,
} from './settingsState.js'

export function SettingsShell({
  snapshot,
  agentsSnapshot,
  cwd,
  memorySnapshot,
  extensionsSnapshot,
  remoteSnapshot,
  remoteLastResult,
  onRemoteVerb,
  onSettingWrite,
  projectBinding,
  projects,
  initialScope = 'user',
  initialCategory = 'general',
}: {
  snapshot: SettingsSnapshot | null
  agentsSnapshot?: AgentConfigSnapshot | null
  /** The focused session's cwd. Used ONLY as project IDENTITY — which project
   * the picker can offer and whose files this window has actually read. It never
   * chooses the scope (Law 2). */
  cwd?: string | null
  memorySnapshot?: MemorySnapshot | null
  extensionsSnapshot?: ExtensionsSnapshot | null
  remoteSnapshot?: RemoteSettingsSnapshot | null
  remoteLastResult?: RemoteSettingsResultFrame | null
  onRemoteVerb?: (verb: RemoteVerbMessage) => void
  /** Sends one editable-setting write to the sidecar. The SOURCE it carries is
   * decided by the chosen scope (Law 3), never by where the value resolves. */
  onSettingWrite?: (input: SettingWriteInput) => void
  /** Names the focused session's project (`settingsProjectBinding.ts`), so the
   * picker's "current" entry gets the roster-disambiguated label instead of a
   * bare basename. Optional: without it the cwd's last segment is used. */
  projectBinding?: SettingsProjectBinding
  /** Every project the picker may offer (the merged workspace roster). Only the
   * focused session's project can be READ or WRITTEN in v1; the rest render the
   * honest limit. App wires this in one line when it is free to edit. */
  projects?: readonly SettingsProjectOption[]
  /**
   * Which scope the page opens on. Law 2 makes My defaults the landing scope,
   * so this defaults to `user` and App passes nothing; it exists because the
   * renderer suite is SSR-only and cannot click a scope tab, and every scope but
   * the landing one would otherwise be unrenderable in a test.
   */
  initialScope?: SettingsScopeKind
  initialCategory?: string

  /* Accepted but no longer rendered here — all four feed LIVE session state,
   * which Law 1 moves to the session inspector (`MetadataInspector.tsx` already
   * renders every one of them). Kept in the props type so App keeps type-checking
   * unchanged while it is mid-edit in another session; drop them from App's call
   * site and from here in the same later change. */
  additionalWorkingDirectories?: PermissionContextSnapshot['additionalWorkingDirectories']
  permissionContext?: PermissionContextSnapshot | null
  diagnosticsSnapshot?: DiagnosticsSnapshot | null
  workspaceTrustSnapshot?: WorkspaceTrustSnapshot | null
}) {
  const [scope, setScope] = useState<SettingsScopeKind>(initialScope)
  const [item, setItem] = useState<string>(initialCategory)
  const [query, setQuery] = useState('')
  const [projectLayer, setProjectLayer] =
    useState<SettingsProjectLayer>('projectSettings')
  const [projectCwd, setProjectCwd] = useState<string | null>(null)

  const activeCwd =
    cwd && cwd.trim().length > 0
      ? cwd
      : projectBinding?.bound
        ? projectBinding.cwd
        : null
  const known =
    projects ??
    (projectBinding?.bound
      ? [{ cwd: projectBinding.cwd, name: projectBinding.name }]
      : undefined)
  const projectChoices = selectSettingsProjects(known, activeCwd)
  // Law 2: the current project is offered first but never auto-selected — until
  // the operator picks one, the picker's own first entry is merely what the
  // control displays, and the pane says which project it is describing.
  const selectedProject =
    projectChoices.find(choice => choice.cwd === projectCwd) ??
    projectChoices[0] ??
    null
  const engine: SettingsProjectEngine =
    scope === 'project'
      ? selectProjectEngine(selectedProject?.cwd ?? null, activeCwd)
      : 'live'
  const writeLayer = selectSettingsWriteLayer(scope, projectLayer)
  const activeItem = selectSettingsRailItem(scope, item)
  const rail = selectSettingsRail(scope, query)
  const scopeFile = writeLayer ? selectLayerOrigin(snapshot, writeLayer) : null

  return (
    <div
      aria-label="Settings"
      className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden"
    >
      <header className="shrink-0 border-b border-shell-seam bg-shell-chrome px-6 py-4">
        <h1 className="mb-2.5 text-base font-semibold tracking-tight text-text-primary">
          Settings
        </h1>
        <div
          aria-label="Settings scope"
          className="flex flex-wrap items-center gap-1.5"
          role="group"
        >
          {SETTINGS_SCOPE_KINDS.map(kind => {
            const on = kind === scope
            return (
              <button
                aria-pressed={on}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors ${
                  on
                    ? 'border-accent/40 bg-accent/10 font-semibold text-accent-soft'
                    : 'border-shell-seam text-text-muted hover:bg-shell-hover'
                }`}
                key={kind}
                onClick={() => {
                  setScope(kind)
                  setItem(selectSettingsRailItem(kind, item))
                }}
                type="button"
              >
                {kind === 'project' && selectedProject
                  ? `${SETTINGS_SCOPE_LABEL.project}: ${selectedProject.name}`
                  : SETTINGS_SCOPE_LABEL[kind]}
                {kind === 'enforced' ? <LockIcon className="h-2.5 w-2.5" /> : null}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-text-subtle">
          {SETTINGS_SCOPE_SUBTITLE[scope]}
        </p>
        {scope === 'project' ? (
          <ProjectScopeControls
            choices={projectChoices}
            engine={engine}
            layer={projectLayer}
            onSelectLayer={setProjectLayer}
            onSelectProject={setProjectCwd}
            selected={selectedProject}
          />
        ) : null}
        {writeLayer ? (
          <p className="mt-2 text-[11.5px] leading-relaxed text-text-subtle">
            {SETTINGS_APPLY_NOTE}
            {engine === 'live' && settingsWereRead(snapshot) ? (
              <>
                {' '}
                Anything this page does not show lives in the same file
                {scopeFile ? (
                  <>
                    :{' '}
                    <span className="font-mono text-[11px]">{scopeFile}</span>
                  </>
                ) : (
                  ', which holds no settings yet'
                )}
                .
              </>
            ) : null}
          </p>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-shell-seam bg-shell-chrome px-3 py-5">
          <input
            aria-label="Search settings"
            className="mb-4 w-full rounded-lg border border-shell-seam bg-shell-hover px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none placeholder:text-text-subtle"
            onChange={event => setQuery(event.target.value)}
            placeholder="Search settings"
            value={query}
          />
          {rail.map((group, index) => (
            <div
              aria-label={group.heading ?? undefined}
              className="mb-3"
              key={group.heading ?? `block-${index}`}
              role="group"
            >
              {group.heading ? (
                <div className="mb-1.5 truncate px-2 text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-subtle">
                  {group.heading}
                </div>
              ) : null}
              <div className="flex flex-col gap-px">
                {group.items.map(entry => {
                  const on = entry.id === activeItem
                  return (
                    <button
                      aria-current={on ? 'page' : undefined}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                        on
                          ? 'bg-accent/10 font-semibold text-accent-soft'
                          : 'text-text-muted hover:bg-shell-hover'
                      }`}
                      key={entry.id}
                      onClick={() => setItem(entry.id)}
                      type="button"
                    >
                      <span className="flex-1 truncate">{entry.label}</span>
                      {entry.locked ? (
                        <LockIcon
                          className={
                            on
                              ? 'h-2.5 w-2.5 text-accent-soft'
                              : 'h-2.5 w-2.5 text-text-subtle'
                          }
                        />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {rail.length === 0 ? (
            <div className="px-2 text-xs text-text-subtle">No matches</div>
          ) : null}
          {/* Where the categories that left this page went. Rendered in the rail
           * because that is where someone looks for a missing one. */}
          <p className="mt-auto px-2 pt-6 text-[10.5px] leading-relaxed text-text-subtle">
            {SETTINGS_SESSION_STATE_NOTE}
          </p>
        </nav>

        <div className="flex-1 overflow-y-auto px-8 py-7">
          <div className="mx-auto max-w-[660px]">
            <header className="mb-5">
              <h2 className="text-lg font-semibold tracking-tight text-text-primary">
                {settingsRailItem(activeItem).label}
              </h2>
              <p className="text-[13px] text-text-subtle">
                {settingsRailItem(activeItem).desc}
              </p>
            </header>
            <ScopeBody
              agentsSnapshot={agentsSnapshot ?? null}
              engine={engine}
              extensionsSnapshot={extensionsSnapshot ?? null}
              item={activeItem}
              layer={writeLayer}
              memorySnapshot={memorySnapshot ?? null}
              onRemoteVerb={onRemoteVerb ?? (() => {})}
              onSettingWrite={onSettingWrite ?? (() => {})}
              projectName={selectedProject?.name ?? 'this project'}
              remoteLastResult={remoteLastResult ?? null}
              remoteSnapshot={remoteSnapshot ?? null}
              scope={scope}
              snapshot={snapshot}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The project picker plus the Shared / Just-me layer choice (Law 3's one
 * further explicit choice per write, made once for the pane). */
function ProjectScopeControls({
  choices,
  selected,
  onSelectProject,
  layer,
  onSelectLayer,
  engine,
}: {
  choices: readonly { cwd: string; name: string; current: boolean }[]
  selected: { cwd: string; name: string; current: boolean } | null
  onSelectProject: (cwd: string) => void
  layer: SettingsProjectLayer
  onSelectLayer: (layer: SettingsProjectLayer) => void
  engine: SettingsProjectEngine
}) {
  if (!selected) {
    return (
      <p className="mt-2.5 text-[12px] leading-relaxed text-text-subtle">
        No project is open, so there is none to name. Open a session in a project
        to edit its settings files.
      </p>
    )
  }
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SelectControl
          label="Project"
          onChange={onSelectProject}
          optionLabels={Object.fromEntries(
            choices.map(choice => [
              choice.cwd,
              choice.current ? `${choice.name} (current)` : choice.name,
            ]),
          )}
          options={choices.map(choice => choice.cwd)}
          value={selected.cwd}
        />
        <span className="truncate font-mono text-[11px] text-text-subtle">
          {selected.cwd}
        </span>
      </div>
      <div
        aria-label="Where project edits are saved"
        className="flex flex-wrap items-center gap-1.5"
        role="group"
      >
        {SETTINGS_PROJECT_LAYERS.map(candidate => {
          const on = candidate === layer
          return (
            <button
              aria-pressed={on}
              className={`rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors ${
                on
                  ? 'border-accent/40 bg-accent/10 font-semibold text-accent-soft'
                  : 'border-shell-seam text-text-muted hover:bg-shell-hover'
              }`}
              key={candidate}
              onClick={() => onSelectLayer(candidate)}
              type="button"
            >
              {SETTINGS_PROJECT_LAYER_LABEL[candidate]}
            </button>
          )
        })}
        <span className="text-[11px] text-text-subtle">
          {SETTINGS_PROJECT_LAYER_DESC[layer]}
        </span>
      </div>
      {engine === 'absent' ? (
        <p className="text-[11.5px] leading-relaxed text-tone-warn">
          {settingsNoEngineNote(selected.name)}
        </p>
      ) : null}
    </div>
  )
}

function ScopeBody({
  scope,
  item,
  layer,
  engine,
  projectName,
  snapshot,
  agentsSnapshot,
  extensionsSnapshot,
  memorySnapshot,
  remoteSnapshot,
  remoteLastResult,
  onRemoteVerb,
  onSettingWrite,
}: {
  scope: SettingsScopeKind
  item: SettingsRailItemId
  layer: ReturnType<typeof selectSettingsWriteLayer>
  engine: SettingsProjectEngine
  projectName: string
  snapshot: SettingsSnapshot | null
  agentsSnapshot: AgentConfigSnapshot | null
  extensionsSnapshot: ExtensionsSnapshot | null
  memorySnapshot: MemorySnapshot | null
  remoteSnapshot: RemoteSettingsSnapshot | null
  remoteLastResult: RemoteSettingsResultFrame | null
  onRemoteVerb: (verb: RemoteVerbMessage) => void
  onSettingWrite: (input: SettingWriteInput) => void
}) {
  if (scope === 'app') return <AppScopeBody item={item} />
  if (scope === 'enforced') return <ManagedPanel snapshot={snapshot} />

  // One gate for the whole project scope: nothing in this window has read the
  // chosen project's files, so no pane may show values from the focused
  // session's project as if they were this one's.
  if (engine === 'absent') {
    return (
      <PaneSection title={settingsRailItem(item).label}>
        <p className="text-[12.5px] leading-relaxed text-text-subtle">
          {settingsNoEngineNote(projectName)}
        </p>
      </PaneSection>
    )
  }

  // `layer` is non-null for the user and project scopes (settingsScope.ts).
  const writeLayer = layer ?? 'userSettings'
  const noEngineNote = settingsNoEngineNote(projectName)

  switch (item) {
    case 'general':
      return (
        <SettingsPane
          engine={engine}
          layer={writeLayer}
          noEngineNote={noEngineNote}
          onWrite={onSettingWrite}
          pane="general"
          snapshot={snapshot}
        />
      )
    case 'model':
      return (
        <>
          <SettingsPane
            engine={engine}
            layer={writeLayer}
            noEngineNote={noEngineNote}
            onWrite={onSettingWrite}
            pane="model"
            snapshot={snapshot}
          />
          <DeferredNote note="A default-model select belongs here; it is deferred on the model-list read-seam." />
        </>
      )
    case 'permissions':
      return <PermissionsPane layer={writeLayer} snapshot={snapshot} />
    case 'interface':
      return (
        <>
          <SettingsPane
            engine={engine}
            layer={writeLayer}
            noEngineNote={noEngineNote}
            onWrite={onSettingWrite}
            pane="theme"
            snapshot={snapshot}
          />
          {scope === 'user' ? <KeybindingsRow /> : null}
          <DeferredNote note="Language and reduced-motion are real schema keys with no control yet; they need the shared write allowlist to grow, which is a per-key sidecar review." />
        </>
      )
    case 'privacy':
      return (
        <>
          <SettingsPane
            engine={engine}
            layer={writeLayer}
            noEngineNote={noEngineNote}
            onWrite={onSettingWrite}
            pane="privacy"
            snapshot={snapshot}
          />
          <DeferredNote note="Auto-memory and auto-dream toggles belong here; they need the shared write allowlist to grow, which is a per-key sidecar review." />
        </>
      )
    case 'memory':
      return (
        <>
          <MemoryPage embedded snapshot={memorySnapshot} />
          {scope === 'project' ? (
            <DeferredNote note="This list is not filtered to the project's own CLAUDE.md files yet — every source is shown, each with its own badge." />
          ) : null}
        </>
      )
    case 'agents':
      return <AgentsPage embedded snapshot={agentsSnapshot} />
    case 'skills':
      return <SkillsPanel snapshot={extensionsSnapshot} />
    case 'plugins':
      return <PluginsPanel snapshot={extensionsSnapshot} />
    case 'mcp':
      return <McpPanel snapshot={extensionsSnapshot} />
    case 'hooks':
      return <HooksPanel snapshot={extensionsSnapshot} />
    case 'remote':
      return (
        <>
          <RemoteSettingsPage
            embedded
            lastResult={remoteLastResult}
            onVerb={onRemoteVerb}
            snapshot={remoteSnapshot}
          />
          <DeferredNote note="Only the saved SSH environments below are configuration. The bridge and pairing controls are live operational actions, and re-homing them beside Accounts is deferred." />
        </>
      )
    default:
      // `appearance` / `notifications` / `policy` belong to the other two scopes
      // and cannot reach here (selectSettingsRailItem keeps the rail and the
      // active item in the same scope).
      return null
  }
}

/**
 * The durable half of Permissions.
 *
 * The live half — the running session's mode, its engine-resolved allow/deny/ask
 * rules, managed-rules-only enforcement, the classifier state, this-session
 * extra directories — is per-session state, and it is precisely the thing the
 * operator objected to seeing under a Settings heading. It already renders on
 * the session inspector (`MetadataInspector.tsx` §Permissions, the same
 * `PermissionRulesEditor`), so it is not shown twice here.
 *
 * `permissions.defaultMode` stays READ-ONLY: making it writable means adding a
 * permission-family key to the sidecar's write allowlist, which is a
 * security-baseline change needing an explicit PERMISSION-BOUNDARY review
 * (spec §7.1). Rules stay read-only for a harder reason — the renderer never
 * authors permission rules at all (SECURITY-MINIMUM T6b).
 */
function PermissionsPane({
  snapshot,
  layer,
}: {
  snapshot: SettingsSnapshot | null
  layer: NonNullable<ReturnType<typeof selectSettingsWriteLayer>>
}) {
  const defaultMode = selectPermissionDefaultMode(snapshot)
  const read = settingsWereRead(snapshot)
  const origin = selectLayerOrigin(snapshot, layer)
  return (
    <>
      <PaneSection title="Default mode">
        <Field
          desc="The mode a session starts in. Read-only here — change it from the CLI; letting the renderer write a permission-family key needs a recorded permission-boundary review."
          editable={false}
          label="Default permission mode"
          origin={read && defaultMode ? selectLayerOrigin(snapshot, defaultMode.source) : null}
          source={defaultMode?.source}
        >
          <span
            aria-label={`Default permission mode: ${
              defaultMode ? defaultMode.value : read ? 'not set' : SETTINGS_UNKNOWN_VALUE
            }`}
            className="rounded border border-shell-seam bg-surface-raised px-2 py-1 font-mono text-[12.5px] text-text-primary"
          >
            {defaultMode
              ? defaultMode.value
              : read
                ? 'not set'
                : SETTINGS_UNKNOWN_VALUE}
          </span>
        </Field>
        {/* Only a snapshot that WAS read may speak about the settings files. */}
        {read && !defaultMode ? (
          <p className="mt-2 text-[11.5px] leading-relaxed text-text-subtle">
            <code className="font-mono">permissions.defaultMode</code> is not set
            in any settings file, so the engine chooses each session's opening
            mode.
          </p>
        ) : null}
        {read ? null : (
          <p className="mt-2 text-[11.5px] leading-relaxed text-text-subtle">
            {SETTINGS_UNREAD_NOTE}
          </p>
        )}
      </PaneSection>
      <PaneSection title="Rules">
        <p className="text-[12.5px] leading-relaxed text-text-subtle">
          Allow, deny and ask rules live under{' '}
          <code className="font-mono">permissions</code> in the settings file
          this scope writes
          {origin ? (
            <>
              , <span className="font-mono text-[11px]">{origin}</span>
            </>
          ) : null}
          . This app never authors permission rules, and the settings snapshot
          carries key names without their contents, so they are neither shown nor
          editable here — edit the file, or use the CLI.
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-text-subtle">
          The rules actually in force for a running session are a different
          thing: they include rules added at runtime and mid-turn, so they are
          shown per session, on the session inspector.
        </p>
      </PaneSection>
    </>
  )
}

/** Keybindings are one file for this machine, so no project can override them —
 * the annotation is the whole point of the row. No read seam exists for the
 * file's contents, and one is not invented here. */
function KeybindingsRow() {
  return (
    <PaneSection title="Keybindings">
      <Field
        desc="One file for this machine; projects cannot override it. This app cannot read or edit it yet."
        editable={false}
        label="Keyboard shortcuts"
      >
        <span className="font-mono text-[12.5px] text-text-subtle">
          {SETTINGS_UNKNOWN_VALUE}
        </span>
      </Field>
    </PaneSection>
  )
}

/**
 * The This-app scope: desktop preferences with no settings layer at all.
 *
 * The old page had no home for these, so its one existing control (reasoning
 * layout) sat under a heading that promised engine configuration. Only that
 * control is real today; the rest of the scope is named, not faked.
 */
function AppScopeBody({ item }: { item: SettingsRailItemId }) {
  if (item === 'notifications') {
    return (
      <PaneSection title="Notifications">
        <p className="text-[12.5px] leading-relaxed text-text-subtle">
          System notifications for a finished turn or a waiting permission
          request are not built. Today this app only raises in-window toasts,
          which need the window to be visible.
        </p>
      </PaneSection>
    )
  }
  return (
    <>
      <TranscriptDisplaySection />
      <DeferredNote note="Accent colour, code theme and font, and window &amp; startup behaviour belong in this scope too; none of them has an app-side setting yet, so none is shown." />
    </>
  )
}

/**
 * The one APP-LOCAL editor that exists today: how the transcript renders
 * reasoning summaries (`reasoningLayout.ts`). It carries no `SourceBadge`
 * because it has no settings layer — it is a renderer view preference stored
 * with the workspace layout, not a `SettingsSchema` key the sidecar writes.
 */
function TranscriptDisplaySection() {
  const { mode, setMode } = useContext(ReasoningLayoutContext)
  return (
    <PaneSection title="Transcript">
      <Field
        desc="How reasoning summaries are laid out in the transcript. Which reasoning is shown at all is the engine's separate “Reasoning display” setting under Model &amp; Reasoning. Stored in this app, not in your settings files."
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

/** The Enforced scope: the machine's read-only policy floor. */
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
            settings is{' '}
            <span className="font-mono">{SETTINGS_UNKNOWN_VALUE}</span> until
            then.
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
      {settingsWereRead(snapshot) && managed.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-text-subtle">
          <span>Policy beats every other layer:</span>
          <SourceBadge origin={layerOrigin} source="policySettings" />
        </div>
      ) : null}
    </>
  )
}

/** An honest footnote naming what a pane deliberately does not have yet. */
function DeferredNote({ note }: { note: ReactNode }) {
  return (
    <p className="mt-4 text-[11.5px] leading-relaxed text-text-subtle">{note}</p>
  )
}
