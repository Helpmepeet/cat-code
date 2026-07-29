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
} from './agentIdentity.js'
import {
  AGENT_STATE_TONE_CLASS,
  AGENT_TYPE_TONE_CLASS,
} from './agentChromeModel.js'

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
 * worker's agent type as a soft-tinted pill.
 *
 * Renders nothing only when there is no role at all. An UNKNOWN role still gets
 * a chip: `agentTypeMeta` (`agentIdentity.ts:244-256`) synthesises a neutral
 * meta labelled with the type itself, and returns null strictly for a null or
 * empty string. (This comment previously said "unknown role", which sent P4-34
 * looking for a plain-text fallback that can never render.)
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
