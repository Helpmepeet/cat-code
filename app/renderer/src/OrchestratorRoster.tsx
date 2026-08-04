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
 * NEUTRAL while an orchestrator is active, and only the solo case raises the
 * amber baton.
 *
 * KNOWN DRIFT, flagged for a ruling rather than resolved here: the "solo" axis is
 * `AgentModeSnapshot.active` (`isAgentMode()`), but a blocked worker's handoff is
 * queued to its PARENT loop unconditionally — `handoffStatus` is parsed from the
 * subagent's own result text (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:501,520`)
 * and the notification goes to the spawning conversation whether or not that
 * session is in Agent Mode. So a normal delegating session reads a blocked worker
 * as user-owned when the assistant on that thread actually owns it. The derivation
 * is P4-8a's, shipped and test-pinned; this surface is the first to render it.
 */
import {
  AgentHandle,
  AgentPip,
  AgentRoleDot,
  AgentStateLabel,
  Baton,
} from './AgentChrome.js'
import {
  deriveWorkerOwner,
  displayHandle,
  orchestratorWorkerState,
  selectOrchestratorRosterLine,
  type RosterCount,
} from './orchestratorState.js'
import { agentStateMeta, agentTypeMeta } from './agentIdentity.js'
import { AGENT_STATE_TONE_CLASS } from './agentChromeModel.js'
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
  active,
  compact = false,
  onOpen,
}: {
  workers: readonly AgentModeWorkerItem[]
  /** Is an orchestrator running? Decides whether a blocked worker escalates. */
  active: boolean
  /** Dimmer resting header while the orchestrator itself is generating. */
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
        <WorkerRow onOpen={onOpen} worker={worker} active={active} />
      </div>
    )
  }

  const { lead, tail, anyWorking } = selectOrchestratorRosterLine(workers, active)

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
            <WorkerRow
              key={worker.agentId}
              onOpen={onOpen}
              worker={worker}
              active={active}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        className={ROW_CLASS}
        // A promoted lead raises ITS id (the prototype's "promoted handle opens
        // its thread"); the consumer is P4-32b's `TasksDialog` drilldown, so today
        // App opens the workers list and drops the id.
        onClick={() => onOpen?.(lead?.worker.agentId)}
      >
        {lead ? (
          <PromotedLead
            active={active}
            priority={lead.priority}
            tail={tail}
            worker={lead.worker}
          />
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
  active,
  priority,
  tail,
}: {
  worker: AgentModeWorkerItem
  active: boolean
  priority: number
  tail: RosterCount[]
}) {
  const state = orchestratorWorkerState(worker, active)
  const meta = agentStateMeta(state)
  return (
    <>
      <AgentPip state={state} />
      <WorkerName worker={worker} />
      {/* The tone already carries the escalation (a solo handoff derives the amber
       * `needs-you` state); priority 3 only adds the heavier weight. */}
      <span
        className={
          'shrink-0 whitespace-nowrap font-mono text-[11.5px] ' +
          (priority === 3 ? 'font-bold' : 'font-medium') +
          ' ' +
          AGENT_STATE_TONE_CLASS[meta.tone].text
        }
      >
        {meta.label}
      </span>
      {tail.length > 0 ? <Separator /> : null}
      <CountTail items={tail} />
      <Baton owner={deriveWorkerOwner(worker, active)} />
    </>
  )
}

/**
 * One full roster row: role dot, handle, the delegated task, lifecycle, baton.
 * The prototype's `elapsed` subfield is a ruled waiver (§10 waiver 8): no
 * elapsed field crosses `AgentModeWorkerItem`, and inventing one would be a mock.
 */
function WorkerRow({
  worker,
  active,
  onOpen,
}: {
  worker: AgentModeWorkerItem
  active: boolean
  onOpen?: (agentId?: string) => void
}) {
  const role = agentTypeMeta(worker.role)
  return (
    <button
      type="button"
      className={ROW_CLASS}
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
      <AgentStateLabel state={orchestratorWorkerState(worker, active)} />
      <Baton owner={deriveWorkerOwner(worker, active)} />
    </button>
  )
}

/**
 * How a worker is named on the line. `handle` is null whenever the Agent tool ran
 * unnamed, which is the COMMON case, so there are three honest faces and no
 * invented one:
 *   - a real handle → the mono `@handle` vocabulary;
 *   - no handle but a role → the role label, deliberately NOT in handle styling,
 *     so a type is never mistaken for a name the engine supplied;
 *   - neither → nothing. The role dot, task text and lifecycle still identify the
 *     row, which is better than printing a word no engine field contains.
 */
function WorkerName({ worker }: { worker: AgentModeWorkerItem }) {
  const handle = displayHandle(worker.handle)
  if (handle) return <AgentHandle name={handle} />
  const role = agentTypeMeta(worker.role)
  if (!role) return null
  return (
    <span className="shrink-0 whitespace-nowrap text-[12px] font-medium text-text-muted">
      {role.label}
    </span>
  )
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
