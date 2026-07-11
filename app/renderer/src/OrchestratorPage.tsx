/**
 * OrchestratorPage (P4-8, D2 `decisions/AGENT-CHROME.md`) — the orchestrator/
 * agent-mode surface as a nav destination. Renders the real joined worker snapshot
 * (persisted agent-mode state ∪ live `local_agent` workers) from the
 * `agent-mode.snapshot` read-seam: the mode badge + objective/phase, the roster
 * "whisper" line, and a role-grouped worker list.
 *
 * P4-8b adds the drilldown tranche, all READ-ONLY enrichment over data already on
 * the wire (no new inbound/outbound vocabulary):
 *   - Workers | Leases tabs (Leases reuses the P4-5 accounts snapshot — no second
 *     accounts seam).
 *   - WorkerDetail drilldown: clicking a worker row opens its detail (role/state/
 *     blockReason/verdict/result), with an "Open thread" affordance.
 *   - TasksButton: opens the EXISTING P4-9 background-tasks dialog (`onOpenTasks`).
 *   - "Open thread" enters the App-level `WorkerFocusView` swap (`onFocusWorker`).
 *
 * §0: a Stop/kill affordance (prototype `WBtn`) is DEFERRED — it needs an inbound
 * write verb, and P4-8b adds none; the detail is read-only. Activity timeline +
 * changed files are CUT (D2 §3 fixtures, no wire field). No inline style; static
 * tone→class maps only via the AgentChrome primitives.
 */
import { useState } from 'react'
import {
  AGENT_STATE_TONE_CLASS,
  AgentHandle,
  AgentStateLabel,
  AgentTypeChip,
  Baton,
} from './AgentChrome.js'
import { agentStateMeta, agentTypeMeta } from './agentIdentity.js'
import { LeaseRoster } from './LeaseRoster.js'
import { OrchestratorRoster, OrchestratorWorkerRow } from './OrchestratorRoster.js'
import {
  deriveWorkerOwner,
  displayHandle,
  orchestratorWorkerState,
  selectWorkerById,
  summarizeOrchestratorWorkers,
} from './orchestratorState.js'
import type {
  AccountsSnapshot,
  AgentModeSnapshot,
  AgentModeWorkerItem,
} from '../../shared/protocol.js'

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

/**
 * /tasks affordance — opens the EXISTING P4-9 background-tasks dialog. Badges: a
 * neutral running count + the amber human-attention count (the solo-blocked case
 * that owns the user baton). Blocked-on-orchestrator stays neutral (D2 C2), so it
 * is NOT amber here — the button surfaces only what actually needs the human.
 */
function TasksButton({
  workers,
  active,
  onOpen,
}: {
  workers: readonly AgentModeWorkerItem[]
  active: boolean
  onOpen: () => void
}) {
  const summary = summarizeOrchestratorWorkers(workers, active)
  const attention = summary.user > 0
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Background tasks"
      className={`inline-flex shrink-0 items-center gap-2 rounded-[7px] border px-2.5 py-1 transition-colors hover:bg-shell-hover ${
        attention ? 'border-tone-warn/30' : 'border-shell-seam'
      }`}
    >
      <span className="font-mono text-[11px] text-purple-300">/tasks</span>
      {summary.working > 0 ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-blue-400">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
          {summary.working}
        </span>
      ) : null}
      {summary.user > 0 ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-tone-warn">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-tone-warn" />
          {summary.user}
        </span>
      ) : null}
    </button>
  )
}

/**
 * Worker-detail drilldown body (prototype `WorkerDetail`) — real fields only:
 * the delegated prompt, the blocked "waiting on orchestrator" gate, and the
 * result/verdict. Activity timeline + changed files are CUT (D2 §3 fixtures);
 * a Stop control is deferred (needs an inbound write verb). Read-only.
 */
function WorkerDetail({
  worker,
  active,
  onBack,
  onOpenThread,
}: {
  worker: AgentModeWorkerItem
  active: boolean
  onBack: () => void
  onOpenThread: () => void
}) {
  const state = orchestratorWorkerState(worker, active)
  const owner = deriveWorkerOwner(worker, active)
  const isVerifier = worker.role === 'verification' || worker.verdict !== undefined
  const resultTone = AGENT_STATE_TONE_CLASS[agentStateMeta(state).tone]
  const resultLabel = isVerifier
    ? `Verdict${worker.verdict ? ` · ${worker.verdict}` : ''}`
    : 'Result'

  return (
    <div className="mt-6 flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 text-[11.5px] text-text-muted transition-colors hover:text-text-primary"
      >
        <span aria-hidden className="text-[13px]">‹</span>
        All workers
      </button>

      <div className="flex flex-wrap items-center gap-2.5">
        <AgentHandle name={displayHandle(worker.handle) ?? 'worker'} />
        <AgentTypeChip role={worker.role} />
        <AgentStateLabel state={state} />
        <Baton owner={owner} />
        <button
          type="button"
          onClick={onOpenThread}
          title="Open this worker's thread"
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-purple-400/30 px-2.5 py-1 text-[11px] font-semibold text-purple-300 transition-colors hover:bg-purple-400/10"
        >
          Open thread
          <span aria-hidden className="text-[12px]">›</span>
        </button>
      </div>

      {worker.description ? (
        <div className="flex flex-col gap-1.5">
          <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-subtle">
            Prompt
          </div>
          <div className="text-[12.5px] leading-relaxed text-text-muted">
            {worker.description}
          </div>
        </div>
      ) : null}

      {worker.handoffStatus === 'blocked' && worker.blockReason ? (
        <div className="rounded-[10px] border border-purple-400/30 bg-purple-400/10 px-3.5 py-3">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span aria-hidden className="text-[11px] text-purple-400">◉</span>
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-purple-300">
              Waiting on orchestrator
            </span>
          </div>
          <div className="text-[12.5px] leading-relaxed text-purple-200">
            {worker.blockReason}
          </div>
          <div className="mt-1.5 text-[10.5px] text-text-subtle">
            The orchestrator resolves this or relays a question to you. You
            don&apos;t act here.
          </div>
        </div>
      ) : null}

      {worker.outputSummary || worker.verdict ? (
        <div className="flex flex-col gap-1.5">
          <div className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] ${resultTone.text}`}>
            {resultLabel}
          </div>
          {worker.outputSummary ? (
            <div className="rounded-[10px] border border-shell-seam bg-shell-hover/20 px-3.5 py-3 text-[12px] leading-relaxed text-text-muted">
              {worker.outputSummary}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TabBar({
  tab,
  onTab,
  workerCount,
  leaseCount,
}: {
  tab: 'workers' | 'leases'
  onTab: (tab: 'workers' | 'leases') => void
  workerCount: number
  leaseCount: number
}) {
  const tabs = [
    { id: 'workers' as const, label: 'Workers', n: workerCount, on: 'border-purple-400 text-text-primary' },
    { id: 'leases' as const, label: 'Leases', n: leaseCount, on: 'border-teal-300 text-text-primary' },
  ]
  return (
    <div className="flex gap-1 border-b border-shell-seam">
      {tabs.map(t => {
        const selected = tab === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={`inline-flex items-center gap-1.5 border-b-[1.5px] px-3 py-2 text-[12px] font-medium transition-colors ${
              selected ? t.on : 'border-transparent text-text-subtle hover:text-text-muted'
            }`}
          >
            {t.label}
            {t.n > 0 ? (
              <span className="font-mono text-[10px] text-text-subtle">{t.n}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function OrchestratorPage({
  snapshot,
  accountsSnapshot = null,
  onOpenTasks,
  onFocusWorker,
}: {
  snapshot: AgentModeSnapshot | null
  /** P4-5 accounts snapshot for the Leases tab (reused, not a second seam). */
  accountsSnapshot?: AccountsSnapshot | null
  /** Opens the existing P4-9 background-tasks dialog. */
  onOpenTasks?: () => void
  /** Enters the App-level WorkerFocusView swap for one worker. */
  onFocusWorker?: (agentId: string) => void
}) {
  const workers = snapshot?.workers ?? []
  const active = snapshot?.active ?? false
  const groups = groupWorkersByRole(workers)
  const leaseCount = accountsSnapshot?.accounts.length ?? 0

  const [tab, setTab] = useState<'workers' | 'leases'>('workers')
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null)
  // Drilldown auto-exits if the selected worker leaves the (re-broadcast)
  // snapshot — never render a stale/fabricated worker.
  const selected = selectWorkerById(snapshot, selectedWorkerId)

  return (
    <div className="flex min-h-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-start justify-between gap-4">
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
          <div className="flex shrink-0 items-center gap-3">
            {onOpenTasks ? (
              <TasksButton workers={workers} active={active} onOpen={onOpenTasks} />
            ) : null}
            <span className="whitespace-nowrap font-mono text-[10.5px] text-text-subtle">
              {PHASE_LABEL[snapshot?.phase ?? 'planning']}
            </span>
          </div>
        </div>

        {selected ? (
          <WorkerDetail
            worker={selected}
            active={active}
            onBack={() => setSelectedWorkerId(null)}
            onOpenThread={() => onFocusWorker?.(selected.agentId)}
          />
        ) : (
          <div className="mt-6 flex flex-col gap-5">
            <TabBar
              tab={tab}
              onTab={setTab}
              workerCount={workers.length}
              leaseCount={leaseCount}
            />

            {tab === 'leases' ? (
              <LeaseRoster snapshot={accountsSnapshot} />
            ) : workers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-shell-seam px-6 py-10 text-center">
                <p className="text-[13px] font-medium text-text-muted">No workers yet</p>
                <p className="mt-1.5 text-[12px] text-text-subtle">
                  They appear here as the orchestrator delegates via the Agent tool.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
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
                          onSelect={() => setSelectedWorkerId(worker.agentId)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
