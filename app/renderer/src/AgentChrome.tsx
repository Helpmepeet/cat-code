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
import type { ReactNode } from 'react'
import {
  agentStateMeta,
  agentTranscriptStateWord,
  agentTypeMeta,
  type AgentStateKey,
} from './agentIdentity.js'
import { faceRects, type FaceAxes } from './agentFace.js'
import type { WorkerOwner } from './orchestratorState.js'
import {
  ACTION_BUTTON_TONE_CLASS,
  AGENT_FACE_IDENTITY_FILL,
  AGENT_STATE_TONE_CLASS,
  AGENT_TYPE_TONE_CLASS,
  SECTION_LABEL_TONE_CLASS,
  type ActionButtonTone,
  type SectionLabelTone,
} from './agentChromeModel.js'

type PipSize = 'xs' | 'sm'
const PIP_SIZE_CLASS: Record<PipSize, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
}

/**
 * The worker's face — a filled 9x9 pixel stamp in the state colour, with every
 * feature cut through to the background (`agentFace.ts` owns the algorithm and
 * the reasons).
 *
 * `shape-rendering="crispEdges"` because the whole point of the redesign is that
 * nothing depends on a sub-pixel stroke: the rects must land on device pixels at
 * 17px as squarely as at 19px.
 *
 * ARIA: `label` is what the face is the ONLY carrier of. Colour and expression
 * are the whole of a card's lifecycle now, so a reader who cannot see either is
 * left with a name and a task and no idea whether the worker is still going —
 * pass the state there. Leave it null wherever the state is already in text
 * beside the stamp (line 2's Failed/Stopped word, the engine's own sentence on a
 * finish row, the group header's own tail), or it gets announced twice.
 */
export function AgentFace({
  axes,
  fill,
  pulse = false,
  size = 19,
  label = null,
}: {
  axes: FaceAxes
  /**
   * The worker's own colour as an index into `AGENT_FACE_IDENTITY_FILL`, handed
   * out by the session registry so two workers on screen do not share one. Never
   * a state.
   */
  fill: number
  pulse?: boolean
  /**
   * 19 in a card or a worker detail header, 17 in a finish row, a group header
   * or an orphan row, 15 in a docked list row, 13 inline in a sentence.
   */
  size?: 19 | 17 | 15 | 13
  label?: string | null
}) {
  const colour = AGENT_FACE_IDENTITY_FILL[fill % AGENT_FACE_IDENTITY_FILL.length]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 9 9"
      shapeRendering="crispEdges"
      className={`shrink-0 ${colour}${pulse ? ' animate-face-pulse' : ''}`}
      {...(label === null ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {faceRects(axes).map(rect => (
        <rect
          key={`${rect.x}:${rect.y}`}
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
        />
      ))}
    </svg>
  )
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

/** Compact normalized worker type text for roster/list rows. */
export function AgentTypeLabel({ role }: { role: string | null }) {
  const meta = agentTypeMeta(role)
  if (!meta) return null
  const tone = AGENT_TYPE_TONE_CLASS[meta.tone]
  return (
    <span
      className={`shrink-0 whitespace-nowrap font-mono text-[10.5px] font-medium ${tone.text}`}
    >
      {meta.label}
    </span>
  )
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

/**
 * The worker's name in mono — a web-native mention, not a terminal tree row.
 * BARE, with no at-sign: the prefix is engine mention syntax and the operator
 * ruled (2026-08-21) that it never reaches the screen.
 */
export function AgentHandle({ name, className }: { name: string; className?: string }) {
  return (
    <span className={`shrink-0 whitespace-nowrap font-mono text-[12.5px] font-semibold text-purple-200 ${className ?? ''}`}>
      {name}
    </span>
  )
}

/** Pip + lifecycle word (e.g. a purple "Waiting on the assistant"). */
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
 * Compressed lifecycle word for crowded rows (P4-32b) — the prototype's
 * `agentTranscriptStateWord` output in mono, toned by the same state vocabulary
 * `AgentStateLabel` uses. Pairs with a leading `AgentPip` where the host wants a
 * dot; on its own it is just the word.
 */
export function AgentStateWord({ state }: { state: AgentStateKey }) {
  const tone = AGENT_STATE_TONE_CLASS[agentStateMeta(state).tone]
  return (
    <span className={`shrink-0 whitespace-nowrap font-mono text-[10.5px] ${tone.text}`}>
      {agentTranscriptStateWord(state)}
    </span>
  )
}

/**
 * Uppercase section caption (P4-32b) — the prototype's `WLabel`
 * (`OrchestratorMode.jsx:90`) and `AgentTranscriptLabel`
 * (`AgentIdentity.jsx:160`), which are the same primitive at the same size in two
 * files. One component serves both so a caption cannot drift between the
 * inspection panel and an agent card.
 *
 * `tone` picks the caption colour for the sections that carry one in the
 * prototype (purple for the orchestrator-owned block note, teal for the lease
 * rollup); default is the muted caption.
 */
export function AgentSectionLabel({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: SectionLabelTone
}) {
  const toneClass = SECTION_LABEL_TONE_CLASS[tone]
  return (
    <div
      className={`text-[9.5px] font-bold uppercase tracking-[0.1em] ${toneClass}`}
    >
      {children}
    </div>
  )
}

/**
 * Outline action button (P4-32b) — the prototype's `WBtn`
 * (`OrchestratorMode.jsx:93`). The only production tone in use is `danger`
 * (the worker Stop control); `neutral`/`accent` exist because the primitive is
 * shared and the prototype defines all three.
 */
export function AgentActionButton({
  label,
  tone = 'neutral',
  title,
  onClick,
}: {
  label: string
  tone?: ActionButtonTone
  title?: string
  onClick: () => void
}) {
  const toneClass = ACTION_BUTTON_TONE_CLASS[tone]
  return (
    <button
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border bg-transparent px-[11px] py-1 text-[11.5px] font-medium hover:bg-white/5 ${toneClass}`}
      onClick={onClick}
      type="button"
      {...(title ? { title } : {})}
    >
      {label}
    </button>
  )
}

/**
 * Orchestrator-mode marker (the prototype's `OrchestratorBadge`,
 * OrchestratorMode.jsx:410-417). It rides the session TAB next to the title
 * (B1) because the chat pane deliberately has no header, and with `onToggle` it
 * IS the mode switch (M1) — the switch must stay reachable once the transcript
 * has messages, which the empty-state reflect could not do.
 *
 * Off + interactive collapses to the icon alone: a lit "Orchestrator" pill on a
 * session that is not in the mode would name a state the user did not choose.
 * Off + passive renders nothing at all.
 *
 * `stopPropagation` is deliberate: the host row (a tab) is itself clickable, so
 * without it toggling the mode would also re-select the tab.
 */
export function OrchestratorBadge({
  active,
  onToggle,
  sessionLabel,
}: {
  active: boolean
  onToggle?: (next: boolean) => void
  sessionLabel?: string
}) {
  if (!active && !onToggle) return null
  const icon = <OrchestratorGlyph />
  const forSession = sessionLabel ? ` for session ${sessionLabel}` : ''

  if (!onToggle) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-purple-400/25 bg-purple-400/10 px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.04em] text-purple-300"
        title="Orchestrator mode is on"
      >
        {icon}
        Orchestrator
      </span>
    )
  }

  const action = active ? 'Turn off Orchestrator mode' : 'Turn on Orchestrator mode'
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`${action}${forSession}`}
      title={action}
      onClick={event => {
        event.stopPropagation()
        onToggle(!active)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      }}
      className={
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.04em] transition-colors ' +
        (active
          ? 'border-purple-400/25 bg-purple-400/10 text-purple-300'
          : 'border-transparent bg-transparent text-text-ghost hover:border-purple-400/25 hover:text-purple-300')
      }
    >
      {icon}
      {active ? 'Orchestrator' : null}
    </button>
  )
}

/** The prototype's orchestrator glyph: one branch handing off to another. */
function OrchestratorGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

/**
 * Attention baton — the owner chip. Always neutral (→assistant): no worker on
 * this seam can put the next action on the human, so the amber →you face was
 * removed with the `user` owner it rendered (see `orchestratorState.ts`).
 */
export function Baton({ owner }: { owner: WorkerOwner }) {
  if (owner === 'none') return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-purple-400/30 bg-transparent px-1.5 py-px font-mono text-[10px] font-semibold text-purple-400">
      <span className="opacity-80">→</span>assistant
    </span>
  )
}
