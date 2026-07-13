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
 */

import { useState } from 'react'
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
import { RemoteSettingsPage } from './RemoteSettingsPage.js'
import { SettingsPane } from './SettingsEditors.js'
import type { SettingWriteInput } from './SettingsEditors.js'
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
  SETTING_SOURCE_PRECEDENCE,
} from './settingsState.js'
import { WorkspaceTrustSection } from './WorkspaceTrustSection.js'

type NavItem = { id: string; label: string; locked?: boolean }
type NavGroup = { group: string; items: NavItem[] }

/**
 * Category rail, ported from the prototype's `SETTINGS_NAV` minus the CUT groups
 * (the `Prototype` demo group and `native`, both dropped — INVENTORY CUT list /
 * Settings.jsx note). Every non-Managed body is a P4-x stub for now.
 */
const SETTINGS_NAV: NavGroup[] = [
  {
    group: '',
    items: [
      { id: 'general', label: 'General' },
      { id: 'model', label: 'Model & Inference' },
      { id: 'permissions', label: 'Permissions' },
      { id: 'workspace', label: 'Workspace' },
      { id: 'memory', label: 'Memory' },
      { id: 'privacy', label: 'Privacy' },
    ],
  },
  {
    group: 'Interface',
    items: [
      { id: 'keybindings', label: 'Keybindings' },
      { id: 'theme', label: 'Theme & Output' },
    ],
  },
  {
    group: 'Extensions',
    items: [
      { id: 'agents', label: 'Agents' },
      { id: 'mcp', label: 'MCP' },
      { id: 'plugins', label: 'Plugins' },
      { id: 'skills', label: 'Skills' },
      { id: 'hooks', label: 'Hooks' },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'ide', label: 'IDE & LSP' },
      { id: 'remote', label: 'Remote' },
      { id: 'diagnostics', label: 'Diagnostics' },
    ],
  },
  {
    group: 'Organization',
    items: [{ id: 'managed', label: 'Managed', locked: true }],
  },
]

const CAT_DESC: Record<string, string> = {
  general: 'Identity, editor, startup, and update behavior',
  model: 'Default model, reasoning effort, and thinking',
  permissions: 'Default mode and tool allow / deny rules',
  workspace: 'Trust state and accessible directories',
  memory: 'CLAUDE.md instruction files and saved memories',
  privacy: 'Retention, sharing, and crash reporting',
  keybindings: 'Composer mode and keyboard shortcuts',
  theme: 'Accent, syntax highlighting, and output style',
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
  permissions: 'the Permissions domain (P2-4 — rules editor)',
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
  initialCategory = 'general',
}: {
  snapshot: SettingsSnapshot | null
  /** C3 — reused from `permission.context`, not a second seam (§10). */
  additionalWorkingDirectories?: PermissionContextSnapshot['additionalWorkingDirectories']
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
  initialCategory?: string
}) {
  const [active, setActive] = useState(initialCategory)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const filteredNav = SETTINGS_NAV.map(group => ({
    ...group,
    items: group.items.filter(
      item => !q || item.label.toLowerCase().includes(q),
    ),
  })).filter(group => group.items.length > 0)

  const activeItem = SETTINGS_NAV.flatMap(group => group.items).find(
    item => item.id === active,
  )

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
          <div className="mb-3" key={group.group || 'core'}>
            {group.group ? (
              <div className="mb-1.5 px-2 text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-subtle">
                {group.group}
              </div>
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
  if (category === 'workspace') {
    return (
      <WorkspaceTrustSection
        additionalWorkingDirectories={additionalWorkingDirectories}
        cwd={cwd}
        snapshot={workspaceTrustSnapshot}
      />
    )
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
        {managed.length === 0 ? (
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
