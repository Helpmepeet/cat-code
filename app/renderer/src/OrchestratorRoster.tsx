/**
 * Docked orchestrator worker roster (P4-32a, ruling R1 in
 * `decisions/ORCHESTRATOR-IN-SESSION.md` §10) — the prototype's
 * `OrchestratorModeWorkerRoster` (OrchestratorMode.jsx:237-373), mounted in the
 * existing max-740px column immediately above the composer so it shares the
 * transcript's measure. It is NOT the terminal worker tree and NOT a page: the
 * ruling is explicit that orchestrator mode is a mode of the ordinary session.
 *
 * Read-only over the real `agent-mode.snapshot` seam. Every field rendered here
 * crosses the wire from an engine feed (`app/sidecar/agentModeDomain.ts`):
 * handle ← `LocalAgentTask.tsx:152` `agentName` / persisted `handle`
 * (`src/agent-mode/sessionState.ts:28`), role ← `:155` `agentType` / persisted
 * `role` (`:31`), task text ← `src/Task.ts:49` `description` / persisted `:32`,
 * lifecycle ← `status` + `synthesisStatus`/`origin`/`resumable` (`:33-35`) and
 * the real handoff gate `handoffStatus` (`LocalAgentTask.tsx:184`). The
 * prototype's `elapsed`, `model`, `tools`, `acct`, `↑/↓` and `cost` subfields
 * have no field on this seam and are ruled cut/waived (§10) — they are not mocked.
 *
 * Lifecycle vs owner stay two independent axes (D2 §1): a blocked worker is
 * NEUTRAL and its baton points at the assistant, never at the user.
 *
 * The drift this header used to flag was ruled on 2026-08-09 and fixed in
 * `orchestratorState.ts`: the escalation keyed on `AgentModeSnapshot.active`
 * (`isAgentMode()`), but a blocked worker's handoff is queued to its PARENT loop
 * unconditionally — `handoffStatus` is parsed from the subagent's own result text
 * (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:501,520`) and the notification goes
 * to the spawning conversation whether or not that session is in Agent Mode. So a
 * normal delegating session read a blocked worker as user-owned when the assistant
 * on that thread actually owned it. There is no `active` axis on this surface now.
 */
import {
  AgentHandle,
  AgentPip,
  AgentRoleDot,
  AgentTypeLabel,
  Baton,
} from './AgentChrome.js'
import {
  deriveWorkerOwner,
  orchestratorWorkerState,
  selectOrchestratorRosterLine,
  selectWorkerDisplayName,
  workerAccessibleLabel,
  type RosterCount,
} from './orchestratorState.js'
import { agentTypeMeta } from './agentIdentity.js'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'

/** Count tones as literal classes — never an interpolated arbitrary value. */
const COUNT_TONE_CLASS: Record<RosterCount['tone'], string> = {
  working: 'text-blue-400',
  waiting: 'text-stone-400',
  done: 'text-text-faint',
}

const ROW_CLASS =
  'flex w-full items-center gap-2 rounded-[7px] border border-transparent px-[7px] py-[5px] text-left transition-colors hover:border-white/[0.06] hover:bg-white/[0.035]'

export function OrchestratorRoster({
  workers,
  compact = false,
  onOpen,
}: {
  workers: readonly AgentModeWorkerItem[]
  /** Dimmer resting header while the assistant itself is generating. */
  compact?: boolean
  /** Open the workers list; carries the news-bearing worker's id when there is one. */
  onOpen?: (agentId?: string) => void
}) {
  if (workers.length === 0) return null

  if (workers.length === 1) {
    const worker = workers[0]
    if (!worker) return null
    return (
      <div className="mx-1 mb-0.5 rounded-[10px] bg-app-bg px-1 py-[3px]">
        <WorkerRow onOpen={onOpen} worker={worker} />
      </div>
    )
  }

  const { lead, tail, anyWorking } = selectOrchestratorRosterLine(workers)

  return (
    <div className="group relative mx-1 mb-0.5 rounded-[10px] bg-app-bg px-1 py-[3px]">
      {/* The full roster, one gesture away. Hover OR keyboard focus reveals it
       * (the prototype is hover-only, so its popover is unreachable by keyboard);
       * always in the DOM so it costs nothing to open. */}
      <div className="absolute inset-x-1 bottom-full z-40 hidden pb-1.5 group-hover:block group-focus-within:block">
        <div className="rounded-[10px] border border-white/[0.08] bg-surface-panel px-1 pb-[5px] pt-1 shadow-[0_14px_34px_rgba(0,0,0,0.5)]">
          <div className="px-2 pb-[3px] pt-[5px] font-mono text-[9px] tracking-[0.1em] text-text-faint">
            {workers.length} SUBAGENTS
          </div>
          {workers.map(worker => (
            <WorkerRow key={worker.agentId} onOpen={onOpen} worker={worker} />
          ))}
        </div>
      </div>

      <button
        type="button"
        className={ROW_CLASS}
        aria-label={rosterAccessibleLabel(lead?.worker ?? null, tail, workers.length)}
        // A promoted lead raises ITS id (the prototype's "promoted handle opens
        // its thread"); the consumer is P4-32b's `TasksDialog` drilldown, so today
        // App opens the workers list and drops the id.
        onClick={() => onOpen?.(lead?.worker.agentId)}
      >
        {lead ? (
          <PromotedLead tail={tail} worker={lead.worker} />
        ) : (
          <>
            <span
              className={
                'inline-block h-[7px] w-[7px] shrink-0 rounded-full ' +
                (anyWorking ? 'animate-pulse bg-blue-400' : 'bg-text-ghost')
              }
              aria-hidden="true"
            />
            <span
              className={
                'shrink-0 font-mono text-[11px] font-semibold ' +
                (compact ? 'text-text-faint' : 'text-text-subtle')
              }
            >
              {workers.length} subagents
            </span>
            <Separator />
            <CountTail
              items={tail.length > 0 ? tail : [{ text: 'idle', tone: 'done' }]}
            />
            <span className="flex-1" />
          </>
        )}
        <Chevron />
      </button>
    </div>
  )
}

/** The news-bearing worker, promoted onto the line ahead of the neutral counts. */
function PromotedLead({
  worker,
  tail,
}: {
  worker: AgentModeWorkerItem
  tail: RosterCount[]
}) {
  const state = orchestratorWorkerState(worker)
  const name = selectWorkerDisplayName(worker)
  return (
    <>
      <AgentPip state={state} />
      <WorkerName worker={worker} />
      {!name && worker.description ? (
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-subtle">
          {worker.description}
        </span>
      ) : null}
      <AgentTypeLabel role={worker.role} />
      {tail.length > 0 ? <Separator /> : null}
      <CountTail items={tail} />
      <Baton owner={deriveWorkerOwner(worker)} />
    </>
  )
}

/**
 * One full roster row: role dot, genuine handle, delegated task, lifecycle pip,
 * normalized worker type, and baton.
 * The prototype's `elapsed` subfield is a ruled waiver (§10 waiver 8): no
 * elapsed field crosses `AgentModeWorkerItem`, and inventing one would be a mock.
 */
function WorkerRow({
  worker,
  onOpen,
}: {
  worker: AgentModeWorkerItem
  onOpen?: (agentId?: string) => void
}) {
  const role = agentTypeMeta(worker.role)
  return (
    <button
      type="button"
      className={ROW_CLASS}
      aria-label={workerAccessibleLabel(worker)}
      // The id is raised for P4-32b's read-only `TasksDialog` worker drilldown
      // (ruling D1); App currently opens the dialog and drops it, so a click
      // lands on the workers list rather than this worker. Not broken, deferred.
      onClick={() => onOpen?.(worker.agentId)}
      title={role?.label ?? undefined}
    >
      <AgentRoleDot role={worker.role} />
      <WorkerName worker={worker} />
      {worker.description ? (
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-subtle">
          {worker.description}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <AgentPip state={orchestratorWorkerState(worker)} />
      <AgentTypeLabel role={worker.role} />
      <Baton owner={deriveWorkerOwner(worker)} />
    </button>
  )
}

/**
 * How a worker is named on the line. `handle` is null whenever the Agent tool ran
 * unnamed, which is the COMMON case, so there are three honest faces and no
 * invented one:
 *   - a genuine handle → the mono `@handle` vocabulary;
 *   - null, blank, or legacy `handle === agentId` → nothing;
 *   - the task description and normalized type remain separate row fields.
 */
function WorkerName({ worker }: { worker: AgentModeWorkerItem }) {
  const name = selectWorkerDisplayName(worker)
  return name ? <AgentHandle name={name} /> : null
}

function rosterAccessibleLabel(
  lead: AgentModeWorkerItem | null,
  tail: readonly RosterCount[],
  workerCount: number,
): string {
  const subject = lead
    ? workerAccessibleLabel(lead)
    : `${workerCount} subagents`
  const counts = tail.map(item => item.text)
  if (!lead && counts.length === 0) counts.push('idle')
  return [subject, ...counts].join(', ')
}

function CountTail({ items }: { items: readonly RosterCount[] }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-[7px]">
      {items.map((item, index) => (
        <span className="inline-flex items-center gap-[7px]" key={item.text}>
          {index > 0 ? <Separator /> : null}
          <span
            className={`whitespace-nowrap font-mono text-[11.5px] font-medium ${COUNT_TONE_CLASS[item.tone]}`}
          >
            {item.text}
          </span>
        </span>
      ))}
    </span>
  )
}

function Separator() {
  return (
    <span aria-hidden="true" className="shrink-0 text-text-ghost">
      ·
    </span>
  )
}

function Chevron() {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 font-mono text-[13px] leading-none text-text-ghost"
    >
      ›
    </span>
  )
}
