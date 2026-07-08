import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AgentConfigDefinition,
  AgentConfigSnapshot,
  AgentConfigSourceId,
  AgentConfigTools,
} from '../../shared/protocol.js'
import { SourceBadge, LockIcon } from './SettingsField.js'
import {
  selectAgentConfigCounts,
  selectAgentConfigGroups,
} from './agentConfigState.js'

type SourceMeta = {
  label: string
  origin: string
  className: string
}

const SOURCE_META: Record<AgentConfigSourceId, SourceMeta> = {
  'built-in': {
    label: 'Built-in',
    origin: 'Shipped with Cat Code',
    className: 'text-text-subtle bg-white/5 border-white/10',
  },
  plugin: {
    label: 'Plugin',
    origin: 'From an installed plugin',
    className: 'text-cyan-300 bg-cyan-300/10 border-cyan-300/25',
  },
  userSettings: {
    label: 'User',
    origin: '~/.cat-code/agents/*.md',
    className: 'text-source-user bg-source-user/10 border-source-user/25',
  },
  projectSettings: {
    label: 'Project',
    origin: '.cat-code/agents/*.md',
    className: 'text-source-project bg-source-project/10 border-source-project/25',
  },
  localSettings: {
    label: 'Local',
    origin: '.cat-code/agents/*.md local layer',
    className: 'text-source-local bg-source-local/10 border-source-local/25',
  },
  flagSettings: {
    label: 'Flag',
    origin: 'Session flag settings',
    className: 'text-source-flag bg-source-flag/10 border-source-flag/25',
  },
  policySettings: {
    label: 'Managed',
    origin: 'Organization policy',
    className: 'text-source-policy bg-source-policy/10 border-source-policy/25',
  },
}

const AGENT_DOT_CLASS: Record<string, string> = {
  red: 'bg-tone-danger',
  blue: 'bg-source-project',
  green: 'bg-tone-good',
  yellow: 'bg-tone-warn',
  purple: 'bg-source-local',
  orange: 'bg-orange-400',
  pink: 'bg-accent',
  cyan: 'bg-cyan-300',
}

export function AgentsPage({
  snapshot,
  embedded = false,
}: {
  snapshot: AgentConfigSnapshot | null
  embedded?: boolean
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const groups = useMemo(() => selectAgentConfigGroups(snapshot), [snapshot])
  const counts = selectAgentConfigCounts(snapshot)
  const selected = snapshot?.definitions.find(definition => definition.id === selectedId) ?? null

  const body = (
    <>
      <div className="mb-2 flex items-start justify-between gap-3">
        {embedded ? (
          <span className="text-[13px] text-text-subtle">
            {counts.total} agent definition{counts.total === 1 ? '' : 's'}
          </span>
        ) : (
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-text-primary">
              Agents
            </h1>
            <p className="text-[13px] text-text-subtle">
              {counts.total} agent definition{counts.total === 1 ? '' : 's'} · {counts.active}{' '}
              active
            </p>
          </div>
        )}
        <span className="rounded-lg border border-dashed border-shell-seam px-3 py-1.5 text-[12px] text-text-subtle">
          Read-only snapshot
        </span>
      </div>

      <p className="mb-4 text-[11.5px] leading-relaxed text-text-subtle">
        Definitions in <code className="font-mono text-text-muted">.cat-code/agents/*.md</code>,
        built-ins, plugins, flags, and managed policy. Running workers belong on the
        Orchestrator and Tasks surfaces, not this config page.
      </p>

      <div className="mb-5 grid gap-2 text-[11.5px] text-text-subtle sm:grid-cols-3">
        <SummaryCard label="Active" value={counts.active} />
        <SummaryCard label="Unavailable" value={counts.unavailable} />
        <SummaryCard label="Overridden" value={counts.overridden} />
      </div>

      <div className="mb-5 rounded-lg border border-shell-seam bg-shell-hover/35 px-3 py-2.5 text-[11.5px] leading-relaxed text-text-subtle">
        <div className="mb-1 font-semibold text-text-muted">Scope flags</div>
        <ul className="ml-4 list-disc space-y-1">
          <li>New, edit, duplicate, and delete actions are deferred until a safe writer is wired.</li>
          <li>System prompt bodies, hook payloads, and inline MCP configs are withheld at the boundary.</li>
          <li>Provider is runtime-selected; definitions only persist the model alias.</li>
        </ul>
      </div>

      {snapshot?.failedFiles.length ? (
        <div className="mb-5 rounded-lg border border-tone-warn/25 bg-tone-warn/10 px-3 py-2 text-[12px] text-tone-warn">
          {snapshot.failedFiles.length} agent file{snapshot.failedFiles.length === 1 ? '' : 's'} failed to parse.
        </div>
      ) : null}

      {!snapshot ? (
        <EmptyState title="Waiting for the engine's agent config snapshot…" />
      ) : snapshot.definitions.length === 0 ? (
        <EmptyState title="No agent definitions" />
      ) : (
        groups.map(group => (
          <AgentGroup
            key={group.source}
            source={group.source}
            definitions={group.definitions}
            onSelect={definition => setSelectedId(definition.id)}
          />
        ))
      )}

      {selected ? (
        <AgentInspectDrawer definition={selected} onClose={() => setSelectedId(null)} />
      ) : null}
    </>
  )

  if (embedded) return body
  return (
    <div className="relative flex-1 overflow-y-auto px-7 py-7 pb-24">
      <div className="mx-auto max-w-[820px]">{body}</div>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-shell-seam bg-white/[0.02] px-3 py-2">
      <div className="font-mono text-[16px] text-text-primary">{value}</div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-text-subtle">
        {label}
      </div>
    </div>
  )
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="py-14 text-center">
      <div className="mb-1 text-sm font-medium text-text-subtle">{title}</div>
      <div className="text-xs text-text-subtle/75">
        Create or install agent definitions in the real engine config to populate this view.
      </div>
    </div>
  )
}

function AgentGroup({
  source,
  definitions,
  onSelect,
}: {
  source: AgentConfigSourceId
  definitions: AgentConfigDefinition[]
  onSelect: (definition: AgentConfigDefinition) => void
}) {
  const meta = SOURCE_META[source]
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2 px-1">
        <SourceBadge meta={meta} />
        <span className="truncate text-[11px] text-text-subtle">{meta.origin}</span>
        <div className="h-px min-w-5 flex-1 bg-shell-seam" />
        <span className="font-mono text-[10.5px] text-text-subtle">{definitions.length}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {definitions.map(definition => (
          <AgentRow definition={definition} key={definition.id} onSelect={onSelect} />
        ))}
      </div>
    </section>
  )
}

function AgentRow({
  definition,
  onSelect,
}: {
  definition: AgentConfigDefinition
  onSelect: (definition: AgentConfigDefinition) => void
}) {
  return (
    <button
      className={
        'flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ' +
        (definition.available
          ? 'border-white/[0.06] bg-white/[0.015] hover:border-white/15 hover:bg-white/[0.035]'
          : 'border-white/[0.04] bg-white/[0.01] opacity-60 hover:opacity-80')
      }
      onClick={() => onSelect(definition)}
      type="button"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${dotClass(definition.color)}`}
      />
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[13px] font-semibold text-text-primary">
            {definition.agentType}
          </span>
          {!definition.editable ? (
            <span className="shrink-0 text-text-subtle" title={definition.readOnlyReason}>
              <LockIcon className="h-[11px] w-[11px]" />
            </span>
          ) : null}
          <Pill tone={definition.active ? 'good' : 'muted'}>
            {definition.active ? 'active' : 'inactive'}
          </Pill>
          {definition.overriddenBy ? <Pill tone="muted">overridden</Pill> : null}
          {definition.missingMcpServers.length > 0 ? <Pill tone="warn">mcp missing</Pill> : null}
        </span>
        <span className="mb-1 block truncate text-[11.5px] text-text-subtle">
          {definition.whenToUse}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-subtle">
          <Meta label={definition.model ?? 'inherit'} />
          <Meta label={toolsLabel(definition.tools)} />
          {definition.effort !== undefined ? <Meta label={`effort: ${definition.effort}`} /> : null}
          {definition.permissionMode ? <Meta label={definition.permissionMode} /> : null}
          {definition.background ? <Meta label="background" /> : null}
        </span>
      </span>
    </button>
  )
}

function AgentInspectDrawer({
  definition,
  onClose,
}: {
  definition: AgentConfigDefinition
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <>
      <button
        aria-label="Close agent details"
        className="fixed inset-0 z-[80] cursor-default bg-black/50"
        onClick={onClose}
        type="button"
      />
      <aside className="animate-toast-in fixed bottom-0 right-0 top-0 z-[81] flex w-[min(560px,92vw)] flex-col border-l border-shell-seam bg-surface-panel shadow-[-20px_0_60px_rgba(0,0,0,0.6)]">
        <header className="flex shrink-0 items-center gap-2.5 border-b border-shell-seam px-5 py-4">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass(definition.color)}`}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm font-semibold text-text-primary">
              {definition.agentType}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-text-subtle">
              {definition.whenToUse}
            </div>
          </div>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-subtle transition-colors hover:bg-shell-hover hover:text-text-muted"
            onClick={onClose}
            title="Close (Esc)"
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <DetailSection title="Configuration">
            <DetailGrid definition={definition} />
          </DetailSection>

          {definition.tools.mode === 'list' && definition.tools.names.length > 0 ? (
            <DetailSection title="Allowed tools">
              <ChipList items={definition.tools.names} />
            </DetailSection>
          ) : null}

          {definition.disallowedTools?.length ? (
            <DetailSection title="Disallowed tools">
              <ChipList items={definition.disallowedTools} />
            </DetailSection>
          ) : null}

          <DetailSection title="System prompt">
            <div className="rounded-lg border border-shell-seam bg-white/[0.02] px-3.5 py-3 font-mono text-[12px] leading-relaxed text-text-subtle">
              Prompt body is available in the engine definition but withheld from the
              desktop snapshot to avoid moving credential material across the IPC boundary.
            </div>
          </DetailSection>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-shell-seam px-5 py-3.5">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-text-subtle">
            <LockIcon className="h-[11px] w-[11px]" />
            Editing is intentionally deferred for P4-7.
          </span>
        </footer>
      </aside>
    </>
  )
}

function DetailGrid({ definition }: { definition: AgentConfigDefinition }) {
  const source = SOURCE_META[definition.source]
  const rows: Array<[string, ReactNode]> = [
    ['Source', <SourceBadge key="source" meta={source} />],
    ...(definition.plugin ? [['Plugin', definition.plugin] as [string, string]] : []),
    ...(definition.filePath ? [['File', definition.filePath] as [string, string]] : []),
    ['Model', definition.model ?? 'inherit'],
    ['Provider', 'runtime-selected'],
    ['Tools', toolsLabel(definition.tools)],
    ['Active', definition.active ? 'yes' : 'no'],
    ['Available', definition.available ? 'yes' : 'no'],
    ...(definition.effort !== undefined ? [['Effort', String(definition.effort)] as [string, string]] : []),
    ...(definition.permissionMode ? [['Permission mode', definition.permissionMode] as [string, string]] : []),
    ...(definition.maxTurns !== undefined ? [['Max turns', String(definition.maxTurns)] as [string, string]] : []),
    ['Background', definition.background ? 'yes' : 'no'],
    ...(definition.memory ? [['Memory', definition.memory] as [string, string]] : []),
    ...(definition.isolation ? [['Isolation', definition.isolation] as [string, string]] : []),
    ...(definition.requiredMcpServers.length
      ? [['Requires MCP', definition.requiredMcpServers.join(', ')] as [string, string]]
      : []),
    ...(definition.missingMcpServers.length
      ? [['Missing MCP', definition.missingMcpServers.join(', ')] as [string, string]]
      : []),
    ...(definition.skills?.length ? [['Skills', definition.skills.join(', ')] as [string, string]] : []),
    ...(definition.hasInitialPrompt ? [['Initial prompt', 'present, withheld'] as [string, string]] : []),
    ...(definition.hasHooks ? [['Hooks', 'present, payload withheld'] as [string, string]] : []),
    ...(definition.hasMcpServers
      ? [
          [
            'Agent MCP',
            [
              definition.mcpServerRefs.length
                ? `refs: ${definition.mcpServerRefs.join(', ')}`
                : null,
              definition.inlineMcpServerNames.length
                ? `inline: ${definition.inlineMcpServerNames.join(', ')}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'present, config withheld',
          ] as [string, string],
        ]
      : []),
  ]

  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2">
      {rows.map(([label, value]) => (
        <div className="contents" key={label}>
          <span className="text-[12px] text-text-subtle">{label}</span>
          <span className="break-words font-mono text-[12.5px] text-text-muted">{value}</span>
        </div>
      ))}
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-text-subtle">
        {title}
      </div>
      {children}
    </section>
  )
}

function ChipList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(item => (
        <span
          className="rounded border border-shell-seam bg-white/[0.04] px-2 py-0.5 font-mono text-[11.5px] text-text-muted"
          key={item}
        >
          {item}
        </span>
      ))}
    </div>
  )
}

function Pill({
  children,
  tone,
}: {
  children: string
  tone: 'good' | 'muted' | 'warn'
}) {
  return (
    <span
      className={
        'shrink-0 rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.04em] ' +
        (tone === 'good'
          ? 'border-tone-good/25 bg-tone-good/10 text-tone-good'
          : tone === 'warn'
          ? 'border-tone-warn/25 bg-tone-warn/10 text-tone-warn'
          : 'border-white/10 bg-white/[0.04] text-text-subtle')
      }
    >
      {children}
    </span>
  )
}

function Meta({ label }: { label: string }) {
  return <span className="font-mono text-[11px] text-text-subtle">{label}</span>
}

function toolsLabel(tools: AgentConfigTools): string {
  if (tools.mode === 'all') return 'All tools'
  if (tools.mode === 'none') return 'No tools'
  return `${tools.names.length} tool${tools.names.length === 1 ? '' : 's'}`
}

function dotClass(color: string | undefined): string {
  return color ? AGENT_DOT_CLASS[color] ?? 'bg-zinc-600' : 'bg-zinc-700 ring-1 ring-zinc-600'
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <line x1="18" x2="6" y1="6" y2="18" />
      <line x1="6" x2="18" y1="6" y2="18" />
    </svg>
  )
}
