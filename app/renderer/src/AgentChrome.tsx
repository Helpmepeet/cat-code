/**
 * Agent chrome primitives (P4-8, D2) — the web-native React port of the
 * prototype's shared worker vocabulary components (AgentIdentity.jsx:
 * `AgentPip`/`AgentTypeChip`/`AgentHandle`/`AgentStateLabel`, OrchestratorMode.jsx:
 * `LifeDot`/`Baton`). Presentation only over the P4-2 `agentIdentity` vocabulary;
 * no engine data of its own.
 *
 * Colour is routed through STATIC tone→class maps (the `AGENT_DOT_CLASS` idiom,
 * `AgentsPage.tsx:58` / `tasksState.ts:197`) — Tailwind v4 only emits class
 * literals it can statically see, so a dynamic `text-[${hex}]` silently no-ops
 * (the P4-9 colourless-badge bug). Every class below is a literal; the colocated
 * test asserts the maps carry no interpolated/arbitrary classes.
 */
import {
  agentStateMeta,
  agentTypeMeta,
  type AgentStateKey,
  type AgentStateTone,
  type AgentTypeTone,
} from './agentIdentity.js'

/** State-tone → {text, solid dot, ring border, soft bg, soft border} literal classes. */
export const AGENT_STATE_TONE_CLASS: Record<
  AgentStateTone,
  { text: string; dot: string; border: string; soft: string; line: string }
> = {
  // 'running'/'background' — the prototype's blue, not the app's pink accent-info.
  info: { text: 'text-blue-400', dot: 'bg-blue-400', border: 'border-blue-400', soft: 'bg-blue-400/10', line: 'border-blue-400/30' },
  success: { text: 'text-tone-good', dot: 'bg-tone-good', border: 'border-tone-good', soft: 'bg-tone-good/10', line: 'border-tone-good/30' },
  danger: { text: 'text-tone-danger', dot: 'bg-tone-danger', border: 'border-tone-danger', soft: 'bg-tone-danger/10', line: 'border-tone-danger/30' },
  warning: { text: 'text-tone-warn', dot: 'bg-tone-warn', border: 'border-tone-warn', soft: 'bg-tone-warn/10', line: 'border-tone-warn/30' },
  neutral: { text: 'text-stone-400', dot: 'bg-stone-400', border: 'border-stone-400', soft: 'bg-stone-400/10', line: 'border-stone-400/30' },
  muted: { text: 'text-zinc-500', dot: 'bg-zinc-500', border: 'border-zinc-500', soft: 'bg-zinc-500/10', line: 'border-zinc-500/30' },
  // 'waiting' — the orchestrator purple ("Waiting on orchestrator").
  purple: { text: 'text-purple-400', dot: 'bg-purple-400', border: 'border-purple-400', soft: 'bg-purple-400/10', line: 'border-purple-400/30' },
}

/** Type-tone → {text, soft bg, soft border, solid dot} literal classes. */
export const AGENT_TYPE_TONE_CLASS: Record<
  AgentTypeTone,
  { text: string; soft: string; line: string; dot: string }
> = {
  teal: { text: 'text-teal-300', soft: 'bg-teal-300/10', line: 'border-teal-300/30', dot: 'bg-teal-300' },
  blue: { text: 'text-blue-300', soft: 'bg-blue-300/10', line: 'border-blue-300/30', dot: 'bg-blue-300' },
  // NOTE: this 'purple' bucket is shared by coding-worker (violet-400 #a78bfa) and
  // implementor (violet-300 #c4b5fd), and is read by both AgentChrome and
  // TranscriptView. Kept at violet-300 (implementor-correct) to avoid regressing
  // it; the real fix is a per-type split (coding-worker → violet-400) needing a new
  // AgentTypeTone key + agentIdentity mapping + the TranscriptView reader
  // (2026-07-13 UI-drift follow-up, out of the color-only sweep).
  purple: { text: 'text-violet-300', soft: 'bg-violet-300/10', line: 'border-violet-300/30', dot: 'bg-violet-300' },
  sky: { text: 'text-sky-300', soft: 'bg-sky-300/10', line: 'border-sky-300/30', dot: 'bg-sky-300' },
  neutral: { text: 'text-zinc-400', soft: 'bg-zinc-400/10', line: 'border-zinc-400/30', dot: 'bg-zinc-400' },
}

type PipSize = 'xs' | 'sm'
const PIP_SIZE_CLASS: Record<PipSize, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
}

/** Status dot — filled (terminal), ringed (pending/idle), or pulsing (running). */
export function AgentPip({
  state,
  size = 'sm',
}: {
  state: AgentStateKey
  size?: PipSize
}) {
  const meta = agentStateMeta(state)
  const tone = AGENT_STATE_TONE_CLASS[meta.tone]
  const sizeClass = PIP_SIZE_CLASS[size]
  if (meta.icon === 'pip-pulse') {
    return <span className={`inline-block shrink-0 rounded-full ${sizeClass} ${tone.dot} animate-pulse`} />
  }
  if (meta.icon === 'pip-ring') {
    return (
      <span
        className={`inline-block shrink-0 rounded-full border-[1.6px] bg-transparent ${sizeClass} ${tone.border}`}
      />
    )
  }
  return <span className={`inline-block shrink-0 rounded-full ${sizeClass} ${tone.dot}`} />
}

/** Role/type dot (roster row leader) coloured by the agent type. */
export function AgentRoleDot({ role }: { role: string | null }) {
  const meta = agentTypeMeta(role)
  const tone = meta ? AGENT_TYPE_TONE_CLASS[meta.tone] : AGENT_TYPE_TONE_CLASS.neutral
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
}

/**
 * Type/role chip (the prototype's `AgentTypeChip`, AgentIdentity.jsx) — the
 * worker's agent type as a soft-tinted pill. Renders nothing for an unknown role
 * (no fabricated label), matching `agentTypeMeta` returning null.
 */
export function AgentTypeChip({ role }: { role: string | null }) {
  const meta = agentTypeMeta(role)
  if (!meta) return null
  const tone = AGENT_TYPE_TONE_CLASS[meta.tone]
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.05em] font-mono ${tone.text} ${tone.soft} ${tone.line}`}
    >
      {meta.label}
    </span>
  )
}

/** @handle in mono — a web-native mention convention, not a terminal tree row. */
export function AgentHandle({ name, className }: { name: string; className?: string }) {
  return (
    <span className={`shrink-0 whitespace-nowrap font-mono text-[12.5px] font-semibold text-purple-200 ${className ?? ''}`}>
      {name}
    </span>
  )
}

/** Pip + lifecycle word (e.g. a purple "Waiting on orchestrator"). */
export function AgentStateLabel({
  state,
  size = 'sm',
}: {
  state: AgentStateKey
  size?: PipSize
}) {
  const meta = agentStateMeta(state)
  const tone = AGENT_STATE_TONE_CLASS[meta.tone]
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium ${tone.text}`}>
      <AgentPip state={state} size={size} />
      {meta.label}
    </span>
  )
}

/**
 * Attention baton — the owner chip. Neutral (→orchestrator) unless the human owns
 * the next action (→you), the only amber case (D2 C2).
 */
export function Baton({ owner }: { owner: 'none' | 'orchestrator' | 'user' }) {
  if (owner === 'none') return null
  if (owner === 'user') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-tone-warn/30 bg-tone-warn/10 px-1.5 py-px font-mono text-[10px] font-semibold text-tone-warn">
        <span className="opacity-80">→</span>you
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-purple-400/30 bg-transparent px-1.5 py-px font-mono text-[10px] font-semibold text-purple-400">
      <span className="opacity-80">→</span>orchestrator
    </span>
  )
}
