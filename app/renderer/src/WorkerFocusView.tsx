/**
 * WorkerFocusView (P4-8b, D2 `decisions/AGENT-CHROME.md` §2) — the prototype's
 * `enterTeammateView` main-column swap: the whole main column focuses ONE worker
 * the orchestrator delegated. Mounted as an App-level view swap (App owns
 * `focusedWorkerId`, like `activeView`); the roster's "Open thread" affordance
 * enters it, Escape / the back arrow returns to the orchestrator page.
 *
 * §0 CLAIM REDUCED (D2 §2): the prototype promises "messages you send here go to
 * the worker". That needs an inbound resume/message verb, and P4-8b adds NO new
 * inbound wire vocabulary — so this view is READ-ONLY: it shows the worker's task,
 * block gate, and result/verdict, never a composer. The context banner is adapted
 * to say so honestly rather than promise a channel that isn't wired.
 *
 * §0 CUT (D2 §3, fixtures with no wire field): the prototype's activity timeline
 * (`w.progress`) and changed-files list (`w.files`) are mock arrays — not on the
 * `agent-mode.snapshot` `AgentModeWorkerItem`. Dropped, not mocked; live activity
 * is the transcript plane (8c nested frames), not this session-plane view.
 *
 * Renders from real `AgentModeWorkerItem` fields only. No inline style; static
 * tone→class maps only (via the AgentChrome primitives).
 */
import { useEffect } from 'react'
import {
  AGENT_STATE_TONE_CLASS,
  AgentHandle,
  AgentStateLabel,
  AgentTypeChip,
  Baton,
} from './AgentChrome.js'
import { agentStateMeta } from './agentIdentity.js'
import {
  deriveWorkerOwner,
  displayHandle,
  orchestratorWorkerState,
} from './orchestratorState.js'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'

function isVerifier(worker: AgentModeWorkerItem): boolean {
  return worker.role === 'verification' || worker.verdict !== undefined
}

export function WorkerFocusView({
  worker,
  active,
  onBack,
}: {
  worker: AgentModeWorkerItem
  active: boolean
  onBack: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onBack()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBack])

  const state = orchestratorWorkerState(worker, active)
  const owner = deriveWorkerOwner(worker, active)
  const handle = displayHandle(worker.handle) ?? 'worker'
  const resultTone = AGENT_STATE_TONE_CLASS[agentStateMeta(state).tone]
  const resultLabel = isVerifier(worker)
    ? `Verdict${worker.verdict ? ` · ${worker.verdict}` : ''}`
    : 'Result'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {/* Focus header — back-to-orchestrator + "Viewing @handle" + identity. */}
      <div className="flex items-center gap-2.5 border-b border-shell-seam px-6 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to orchestrator (Esc)"
          title="Back to orchestrator (Esc)"
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-muted transition-colors hover:bg-shell-hover hover:text-text-primary"
        >
          <span aria-hidden className="text-[13px]">‹</span>
          Orchestrator
        </button>
        <span className="text-zinc-700">·</span>
        <span className="shrink-0 text-[12px] text-text-subtle">Viewing</span>
        <AgentHandle name={handle} />
        <AgentTypeChip role={worker.role} />
        <AgentStateLabel state={state} />
        <Baton owner={owner} />
        <span className="ml-auto shrink-0 font-mono text-[10px] text-text-subtle">
          esc to return
        </span>
      </div>

      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-8 py-6">
        {/* Read-only context banner (claim reduced — no composer is wired). */}
        <div className="flex items-start gap-2 rounded-[9px] border border-purple-400/30 bg-purple-400/10 px-3 py-2.5">
          <span aria-hidden className="mt-px shrink-0 text-[11px] text-purple-400">◉</span>
          <p className="text-[11.5px] leading-relaxed text-purple-200">
            A worker the orchestrator delegated on this thread. This view is
            read-only — the orchestrator picks up its result or relays a question
            to you in the main chat. You don&apos;t act here.
          </p>
        </div>

        {/* Task from orchestrator (real: the delegated prompt/description). */}
        {worker.description ? (
          <div className="flex flex-col gap-1.5">
            <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-purple-300/80">
              Task from orchestrator
            </div>
            <div className="rounded-[10px] border border-shell-seam bg-shell-hover/20 px-3.5 py-3 text-[13px] leading-relaxed text-text-primary">
              {worker.description}
            </div>
          </div>
        ) : null}

        {/* Blocked / waiting gate (real: handoffStatus + blockReason). */}
        {worker.handoffStatus === 'blocked' && worker.blockReason ? (
          <div className={`rounded-[10px] border px-3.5 py-3 ${resultTone.line} ${resultTone.soft}`}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <span aria-hidden className={`text-[11px] ${resultTone.text}`}>◉</span>
              <span className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] ${resultTone.text}`}>
                {agentStateMeta(state).label}
              </span>
            </div>
            <div className="text-[12.5px] leading-relaxed text-text-muted">
              {worker.blockReason}
            </div>
            <div className="mt-1.5 text-[10.5px] text-text-subtle">
              {owner === 'orchestrator'
                ? 'The orchestrator resolves this or relays a question to you in the main chat.'
                : "No orchestrator is active on this thread to relay this — it's on you to resolve outside this read-only view."}
            </div>
          </div>
        ) : null}

        {/* Result / verdict (real: outputSummary + verdict for verifiers). */}
        {worker.outputSummary || worker.verdict ? (
          <div className="flex flex-col gap-1.5">
            <div className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] ${resultTone.text}`}>
              {resultLabel}
            </div>
            {worker.outputSummary ? (
              <div className="rounded-[10px] border border-shell-seam bg-shell-hover/20 px-3.5 py-3 text-[12.5px] leading-relaxed text-text-muted">
                {worker.outputSummary}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
