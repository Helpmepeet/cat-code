/**
 * OrchestratorPage (P4-8, D2 `decisions/AGENT-CHROME.md`) — the orchestrator/
 * agent-mode surface as a nav destination. Renders the real joined worker snapshot
 * (persisted agent-mode state ∪ live `local_agent` workers) from the
 * `agent-mode.snapshot` read-seam: the mode badge + objective/phase, the roster
 * "whisper" line, and a role-grouped worker list. Read-only in v1 — the worker
 * detail drilldown + teammate focus view + Codex lease roster are deferred
 * (P4-8b/8c, flagged). No inline style; extends the shell grammar.
 */
import { agentTypeMeta } from './agentIdentity.js'
import { OrchestratorRoster, OrchestratorWorkerRow } from './OrchestratorRoster.js'
import type { AgentModeSnapshot, AgentModeWorkerItem } from '../../shared/protocol.js'

/** Orchestrator-mode pill (purple), the mode indicator next to the page title. */
export function OrchestratorBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-purple-400/30 bg-purple-400/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] text-purple-300">
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-purple-400" />
      Orchestrator
    </span>
  )
}

const PHASE_LABEL: Record<AgentModeSnapshot['phase'], string> = {
  planning: 'Planning',
  awaiting_approval: 'Awaiting approval',
  executing: 'Executing',
  verifying: 'Verifying',
  completed: 'Completed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
}

// Known orchestrator roles sort first (stable ordering); any other real agent type
// (implementor / general-purpose / Explore / custom) keeps its place after them —
// never dropped, or a non-orchestrator session's workers vanish from the list.
const ROLE_ORDER = ['agent-mode-coding-worker', 'coding-worker', 'verification']

function roleRank(role: string): number {
  const index = ROLE_ORDER.indexOf(role)
  return index === -1 ? ROLE_ORDER.length : index
}

function groupWorkersByRole(
  workers: readonly AgentModeWorkerItem[],
): { role: string; label: string; items: AgentModeWorkerItem[] }[] {
  const byRole = new Map<string, AgentModeWorkerItem[]>()
  for (const worker of workers) {
    const role = worker.role ?? 'general-purpose'
    const bucket = byRole.get(role)
    if (bucket) bucket.push(worker)
    else byRole.set(role, [worker])
  }
  return [...byRole.entries()]
    .sort(([a], [b]) => roleRank(a) - roleRank(b))
    .map(([role, items]) => ({
      role,
      label: agentTypeMeta(role)?.label ?? role,
      items,
    }))
}

export function OrchestratorPage({ snapshot }: { snapshot: AgentModeSnapshot | null }) {
  const workers = snapshot?.workers ?? []
  const active = snapshot?.active ?? false
  const groups = groupWorkersByRole(workers)

  return (
    <div className="flex min-h-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5">
              <h1 className="text-[19px] font-semibold text-text-primary">Orchestrator</h1>
              <OrchestratorBadge />
            </div>
            <p className="text-[12.5px] text-text-muted">
              {snapshot?.objective
                ? snapshot.objective
                : 'Workers the orchestrator delegates on this thread — you talk only to the orchestrator.'}
            </p>
          </div>
          <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-text-subtle">
            {PHASE_LABEL[snapshot?.phase ?? 'planning']}
          </span>
        </div>

        {workers.length === 0 ? (
          <div className="mt-7 rounded-xl border border-dashed border-shell-seam px-6 py-10 text-center">
            <p className="text-[13px] font-medium text-text-muted">No workers yet</p>
            <p className="mt-1.5 text-[12px] text-text-subtle">
              They appear here as the orchestrator delegates via the Agent tool.
            </p>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            <OrchestratorRoster workers={workers} active={active} />
            <div className="flex flex-col gap-5">
              {groups.map(group => (
                <div key={group.role} className="flex flex-col gap-1">
                  <div className="px-2 pb-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-subtle">
                    {group.label} · {group.items.length}
                  </div>
                  {group.items.map(worker => (
                    <OrchestratorWorkerRow
                      key={worker.agentId}
                      worker={worker}
                      active={active}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
