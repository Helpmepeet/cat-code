/**
 * Settings → Extensions panels (P4-12) — MCP / Plugins / Skills / Hooks, rebuilt
 * in TS/Tailwind on the P0-2 tokens from the prototype's `SettingsExtensions.jsx`
 * (design reference only — zero ported code, no inline `style`). Each panel reads
 * the real `extensions.snapshot` read-seam via `extensionsState.ts` selectors and
 * source-badges every row with P4-3's `SourceBadge`.
 *
 * Deferred surfaces (rendered as honest truth, not mocked — see the report's §0
 * flags and the `protocol.ts` P4-12 header): MCP live connection status / counts
 * / actions; all write toggles (enable/disable/update/install/remove); plugin
 * marketplace browsing; hook last-run outcomes.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ExtensionsSnapshot,
  HookConfigSource,
  HookEntry,
  McpConfigEntry,
  McpConfigScope,
  PluginEntry,
  SettingSourceId,
  SkillConfigSource,
  SkillEntry,
} from '../../shared/protocol.js'
import { PaneSection, SourceBadge } from './SettingsField.js'
import { toneClasses, type Tone } from './tone.js'
import {
  selectHookGroups,
  selectSkillGroups,
} from './extensionsState.js'

/* ----------------------------- primitives ----------------------------- */

const SETTING_SOURCE_IDS = new Set<string>([
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
])

function isSettingSource(source: string): source is SettingSourceId {
  return SETTING_SOURCE_IDS.has(source)
}

/** A tone-driven status dot + label (the prototype's `StatusPill`). */
function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  const t = toneClasses(tone)
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.02em] ${t.text}`}
    >
      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${t.dot}`} />
      {label}
    </span>
  )
}

/** Uppercase mono chip (transport / marketplace source-type). */
function MonoChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[4px] bg-white/5 px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-text-subtle">
      {children}
    </span>
  )
}

/** A "via <plugin>" attribution tag. */
function ViaTag({ name }: { name: string }) {
  return <span className="text-[10px] text-source-local">via {name}</span>
}

/**
 * The provenance badge for a settings-source value (P4-3 `SourceBadge`), or a
 * plain label chip for the wider non-settings sources (plugin/mcp/builtin/…) the
 * `SourceBadge` taxonomy doesn't cover.
 */
function SourceChip({ source, label }: { source: string; label?: string }) {
  if (isSettingSource(source)) {
    return <SourceBadge source={source} />
  }
  return <MonoChip>{label ?? source}</MonoChip>
}

/** Generic list-row card shell (the prototype's `ExtCard`; uniform 1px border). */
function ExtCard({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <div
      className={`mb-2.5 rounded-[10px] border border-white/[0.07] px-4 py-3 ${
        dim ? 'bg-white/[0.012] opacity-70' : 'bg-white/[0.025]'
      }`}
    >
      {children}
    </div>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] text-text-subtle">{children}</p>
}

function DeferredNote({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-2 text-[11.5px] leading-relaxed text-text-subtle">
      {children}
    </div>
  )
}

function WaitingRow() {
  return (
    <EmptyRow>Waiting for the engine&rsquo;s extensions snapshot&hellip;</EmptyRow>
  )
}

/* --------------------------------- MCP -------------------------------- */

// The scope→settings-source collapse the prototype flags (`scopeToSource`). We
// carry the REAL scope in a chip and additionally map to a SourceBadge where the
// scope corresponds to a settings layer.
const MCP_SCOPE_TO_SOURCE: Partial<Record<McpConfigScope, SettingSourceId>> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
  managed: 'policySettings',
  enterprise: 'policySettings',
  dynamic: 'flagSettings',
}

export function McpPanel({ snapshot }: { snapshot: ExtensionsSnapshot | null }) {
  if (!snapshot) return <WaitingRow />
  const servers = snapshot.mcp
  return (
    <PaneSection>
      <DeferredNote>
        Shown from configuration only. Connection status, and connect /
        authenticate / remove, are not available here yet.
      </DeferredNote>
      {servers === null ? (
        <EmptyRow>MCP configuration could not be read.</EmptyRow>
      ) : servers.length === 0 ? (
        <EmptyRow>No MCP servers configured.</EmptyRow>
      ) : (
        servers.map(server => <McpRow key={server.name} server={server} />)
      )}
    </PaneSection>
  )
}

function McpRow({ server }: { server: McpConfigEntry }) {
  const mappedSource = MCP_SCOPE_TO_SOURCE[server.scope]
  const detail =
    server.url ??
    (server.command
      ? `${server.command}${server.argCount ? ` (+${server.argCount} args)` : ''}`
      : '')
  return (
    <ExtCard>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13.5px] font-semibold text-text-primary">
          {server.name}
        </span>
        <StatusPill tone="default" label="Configured" />
        <MonoChip>{server.transport}</MonoChip>
        {mappedSource ? (
          <SourceBadge source={mappedSource} />
        ) : (
          <MonoChip>{server.scope}</MonoChip>
        )}
        {server.pluginSource ? <ViaTag name={server.pluginSource} /> : null}
      </div>
      {detail ? (
        <div className="mt-1 truncate font-mono text-[11px] text-text-subtle">
          {detail}
        </div>
      ) : null}
    </ExtCard>
  )
}

/* ------------------------------- Plugins ------------------------------ */

export function PluginsPanel({
  snapshot,
}: {
  snapshot: ExtensionsSnapshot | null
}) {
  const [tab, setTab] = useState<'installed' | 'marketplace'>('installed')
  if (!snapshot) return <WaitingRow />
  const plugins = snapshot.plugins
  const installedCount = plugins?.length ?? 0
  return (
    <PaneSection>
      <div className="mb-4 flex gap-1 border-b border-shell-seam">
        {(
          [
            ['installed', `Installed · ${installedCount}`],
            ['marketplace', 'Marketplace'],
          ] as const
        ).map(([key, label]) => (
          <button
            aria-current={tab === key ? 'true' : undefined}
            className={`-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ${
              tab === key
                ? 'border-accent font-semibold text-accent-soft'
                : 'border-transparent text-text-subtle hover:text-text-muted'
            }`}
            key={key}
            onClick={() => setTab(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'marketplace' ? (
        <DeferredNote>
          Browsing and installing are not available here. Install plugins from
          the terminal.
        </DeferredNote>
      ) : plugins === null ? (
        <EmptyRow>Plugins could not be loaded.</EmptyRow>
      ) : plugins.length === 0 ? (
        <EmptyRow>No plugins installed.</EmptyRow>
      ) : (
        plugins.map(plugin => <PluginRow key={plugin.id} plugin={plugin} />)
      )}
    </PaneSection>
  )
}

function PluginRow({ plugin }: { plugin: PluginEntry }) {
  return (
    <ExtCard dim={!plugin.enabled}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold text-text-primary">
              {plugin.name}
            </span>
            {plugin.version ? (
              <span className="font-mono text-[11px] text-text-subtle">
                v{plugin.version}
              </span>
            ) : null}
            {plugin.builtin ? <MonoChip>built-in</MonoChip> : null}
            <StatusPill
              tone={plugin.enabled ? 'good' : 'default'}
              label={plugin.enabled ? 'Enabled' : 'Disabled'}
            />
            {plugin.pendingUpdate ? (
              <StatusPill
                tone="info"
                label={`Update staged → v${plugin.pendingUpdate.newVersion}`}
              />
            ) : null}
            {plugin.error ? <StatusPill tone="danger" label="Load error" /> : null}
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-subtle">
            {plugin.source}
          </div>
          <div className="mt-1 text-[11px] text-text-subtle">
            {providesSummary(plugin)}
          </div>
          {plugin.error ? (
            <div className="mt-1 font-mono text-[11px] text-tone-danger">
              {plugin.error}
            </div>
          ) : null}
        </div>
      </div>
    </ExtCard>
  )
}

function providesSummary(plugin: PluginEntry): string {
  const p = plugin.provides
  const parts: string[] = []
  const add = (n: number, label: string) => {
    if (n > 0) parts.push(`${n} ${label}${n > 1 ? 's' : ''}`)
  }
  add(p.commands, 'cmd')
  add(p.agents, 'agent')
  add(p.skills, 'skill')
  add(p.hooks, 'hook')
  if (p.mcpServers > 0) parts.push(`${p.mcpServers} MCP`)
  add(p.lsp, 'LSP')
  return parts.length > 0 ? parts.join(' · ') : 'No contributions'
}

/* -------------------------------- Skills ------------------------------ */

export function SkillsPanel({
  snapshot,
}: {
  snapshot: ExtensionsSnapshot | null
}) {
  if (!snapshot) return <WaitingRow />
  const groups = selectSkillGroups(snapshot)
  if (snapshot.skills === null) {
    return (
      <PaneSection>
        <EmptyRow>Skills could not be read from the command catalog.</EmptyRow>
      </PaneSection>
    )
  }
  const total = snapshot.skills.length
  return (
    <PaneSection>
      <div className="mb-4 text-[11.5px] leading-relaxed text-text-subtle">
        {total} skill{total === 1 ? '' : 's'} across {groups.length} source
        {groups.length === 1 ? '' : 's'}. Skills are prompt-commands; the{' '}
        <span className="font-mono text-text-muted">Manual only</span> and{' '}
        <span className="font-mono text-text-muted">Not user-invocable</span> flags
        are read-only here (toggling is deferred to a settings writer).
      </div>
      {total === 0 ? (
        <EmptyRow>No skills loaded for this session.</EmptyRow>
      ) : (
        groups.map(group => (
          <div className="mb-5" key={group.source}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-subtle">
                {group.label}
              </span>
              <SourceChip source={group.source} label={group.label} />
              <span className="text-[10px] text-text-subtle">
                {group.skills.length}
              </span>
            </div>
            {group.skills.map((skill, index) => (
              // name+source is not unique — two plugins can each contribute a
              // same-named skill (both `source:'plugin'`); the group index
              // disambiguates (mirrors HookRow's `:${index}` key).
              <SkillRow key={`${skill.name}:${skill.source}:${index}`} skill={skill} />
            ))}
          </div>
        ))
      )}
    </PaneSection>
  )
}

function SkillRow({ skill }: { skill: SkillEntry }) {
  return (
    <ExtCard>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold text-text-primary">
          /{skill.name}
        </span>
        {skill.context === 'fork' ? (
          <span className="rounded-[4px] border border-source-local/25 bg-source-local/10 px-1.5 py-px text-[9.5px] font-semibold text-source-local">
            fork{skill.agent ? ` · ${skill.agent}` : ''}
          </span>
        ) : null}
        {skill.pluginName ? <ViaTag name={skill.pluginName} /> : null}
        {skill.disableModelInvocation ? (
          <StatusPill tone="warn" label="Manual only" />
        ) : null}
        {!skill.userInvocable ? (
          <StatusPill tone="default" label="Not user-invocable" />
        ) : null}
      </div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-text-subtle">
        {skill.description}
      </div>
      {skill.whenToUse ? (
        <div className="mt-1 text-[11px] text-text-subtle">
          <span className="text-text-subtle/70">When:</span> {skill.whenToUse}
        </div>
      ) : null}
    </ExtCard>
  )
}

/* -------------------------------- Hooks ------------------------------- */

const HOOK_SOURCE_LABEL: Record<HookConfigSource, string> = {
  userSettings: 'User',
  projectSettings: 'Project',
  localSettings: 'Local',
  flagSettings: 'Flag',
  policySettings: 'Policy',
  pluginHook: 'Plugin',
  sessionHook: 'Session',
  builtinHook: 'Built-in',
}

export function HooksPanel({
  snapshot,
}: {
  snapshot: ExtensionsSnapshot | null
}) {
  if (!snapshot) return <WaitingRow />
  const groups = selectHookGroups(snapshot)
  if (snapshot.hooks === null) {
    return (
      <PaneSection>
        <EmptyRow>Hooks could not be read.</EmptyRow>
      </PaneSection>
    )
  }
  const total = snapshot.hooks.length
  return (
    <PaneSection>
      <div className="mb-4 text-[11.5px] leading-relaxed text-text-subtle">
        {total} hook{total === 1 ? '' : 's'} across {groups.length} event
        {groups.length === 1 ? '' : 's'}. Last-run results are not shown, because
        cat-code does not keep per-hook run history.
      </div>
      {total === 0 ? (
        <EmptyRow>No hooks configured.</EmptyRow>
      ) : (
        groups.map(group => (
          <div className="mb-4" key={group.event}>
            <div className="mb-2 font-mono text-[11px] font-bold tracking-[0.04em] text-source-local">
              {group.event}
            </div>
            {group.hooks.map((hook, index) => (
              <HookRow hook={hook} key={`${hook.event}:${index}`} />
            ))}
          </div>
        ))
      )}
    </PaneSection>
  )
}

function HookRow({ hook }: { hook: HookEntry }) {
  return (
    <ExtCard>
      <div className="flex flex-wrap items-center gap-2">
        <MonoChip>{hook.type}</MonoChip>
        {hook.matcher ? (
          <span className="font-mono text-[11px] text-tone-warn">
            matcher: {hook.matcher}
          </span>
        ) : null}
        <SourceChip
          source={hook.source}
          label={HOOK_SOURCE_LABEL[hook.source]}
        />
        {hook.pluginName ? <ViaTag name={hook.pluginName} /> : null}
        {hook.async ? (
          <span className="text-[10px] text-source-project">async</span>
        ) : null}
      </div>
      <div className="mt-1 break-all font-mono text-[11.5px] leading-relaxed text-text-muted">
        {hook.displayLine}
      </div>
    </ExtCard>
  )
}
