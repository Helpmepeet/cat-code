/**
 * OrchestratorModeWorkerRoster (P4-8, D2) — the compact worker "whisper" line
 * ported from OrchestratorMode.jsx. At rest it names nobody and shows neutral
 * counts; on news it promotes the one worker that matters (a solo escalation, a
 * failure, or a ready result) with its baton. Data is the real joined worker
 * snapshot; all derivation is read-time (`orchestratorState`), never stored.
 *
 * Reusable: the page mounts it as a header summary; a later session (P4-8b) can
 * mount the same component above the composer.
 */
import { AgentHandle, AgentPip, AgentRoleDot, AgentStateLabel, Baton } from './AgentChrome.js'
import {
  deriveWorkerOwner,
  displayHandle,
  orchestratorWorkerState,
  selectPromotedWorker,
  summarizeOrchestratorWorkers,
} from './orchestratorState.js'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'

function CountTail({
  workers,
  active,
}: {
  workers: readonly AgentModeWorkerItem[]
  active: boolean
}) {
  const summary = summarizeOrchestratorWorkers(workers, active)
  const items: { text: string; className: string }[] = []
  if (summary.working > 0) items.push({ text: `${summary.working} working`, className: 'text-blue-400' })
  if (summary.orchestrator > 0)
    items.push({ text: `${summary.orchestrator} on orchestrator`, className: 'text-purple-400' })
  if (summary.user > 0) items.push({ text: `${summary.user} needs you`, className: 'text-tone-warn' })
  if (summary.done > 0) items.push({ text: `${summary.done} done`, className: 'text-zinc-500' })
  if (items.length === 0) items.push({ text: 'idle', className: 'text-zinc-500' })
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {items.map((item, index) => (
        <span key={item.text} className="inline-flex items-center gap-2">
          {index > 0 ? <span className="text-zinc-700">·</span> : null}
          <span className={`whitespace-nowrap font-mono text-[11.5px] font-medium ${item.className}`}>
            {item.text}
          </span>
        </span>
      ))}
    </span>
  )
}

export function OrchestratorRoster({
  workers,
  active,
}: {
  workers: readonly AgentModeWorkerItem[]
  active: boolean
}) {
  if (workers.length === 0) return null

  const lead = selectPromotedWorker(workers, active)
  const anyRunning = workers.some(worker => orchestratorWorkerState(worker, active) === 'running')

  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-shell-seam bg-shell-chrome px-3 py-2">
      {lead ? (
        <>
          <AgentPip state={orchestratorWorkerState(lead.worker, active)} size="sm" />
          <AgentHandle name={displayHandle(lead.worker.handle) ?? 'worker'} />
          <AgentStateLabel state={orchestratorWorkerState(lead.worker, active)} />
          <span className="text-zinc-700">·</span>
          <CountTail workers={workers} active={active} />
          <Baton owner={deriveWorkerOwner(lead.worker, active)} />
        </>
      ) : (
        <>
          {anyRunning ? (
            <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-400" />
          ) : (
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-700" />
          )}
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px] font-semibold text-text-muted">
            {workers.length} subagent{workers.length > 1 ? 's' : ''}
          </span>
          <span className="text-zinc-700">·</span>
          <CountTail workers={workers} active={active} />
        </>
      )}
    </div>
  )
}

/**
 * A single worker row for the role-grouped list (dot · handle · task · state ·
 * baton). When `onSelect` is provided (P4-8b) the row is a button that opens the
 * worker-detail drilldown; without it the row is a static div (8a behaviour).
 */
export function OrchestratorWorkerRow({
  worker,
  active,
  onSelect,
}: {
  worker: AgentModeWorkerItem
  active: boolean
  onSelect?: () => void
}) {
  const inner = (
    <>
      <AgentRoleDot role={worker.role} />
      <AgentHandle name={displayHandle(worker.handle) ?? 'worker'} />
      {worker.description ? (
        <span className="min-w-0 flex-1 truncate text-left text-[11.5px] text-text-subtle">
          {worker.description}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <AgentStateLabel state={orchestratorWorkerState(worker, active)} />
      <Baton owner={deriveWorkerOwner(worker, active)} />
    </>
  )
  if (onSelect) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-shell-hover"
      >
        {inner}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-shell-hover">
      {inner}
    </div>
  )
}
