import type { NestedToolUseRow as ToolUseNestedRow } from './transcriptProjector.js'
import type { AgentStateKey, AgentToolSource } from './agentIdentity.js'
import type { LeaseSnapshot } from '../../shared/protocol.js'
import { selectBashCardText } from './bashCommandLabel.js'
import { peerActivityText } from './peerSurfaces.js'
import { deriveTarget } from './transcriptToolTarget.js'
import { leaseAccountShortLabel, selectLeaseForLabel, selectLeaseForOwner } from './leaseState.js'

function compactCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`
}

/**
 * The transcript-derived Agent source for the P4-2 vocabulary. Every field comes
 * from THIS row: the `tool_use` `input` (`subagent_type`/`description`/`prompt`/
 * `run_in_background`, the real Agent-tool input keys — `AgentTool/UI.tsx`) and
 * the read-time correlated `status`. It NEVER reads the session-plane
 * `workers.snapshot` (`workersState.ts`) — that cross-plane read is the
 * D2 §4 sin the decision forbids.
 */
export function agentToolSourceOf(row: ToolUseNestedRow): AgentToolSource {
  const input = row.input
  const str = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const subagentType = str('subagent_type')
  const description = str('description')
  const prompt = str('prompt')
  const isLaunchRecord =
    (row.toolName === 'Agent' || row.toolName === 'Task') &&
    input.run_in_background === true
  // Identity is transcript-owned in either state: the completed result carries
  // it on the parent correlation, while a running worker carries it on its
  // nested progress frames. No live task snapshot joins this card.
  let nestedAgentName: string | undefined
  for (const child of row.children) {
    if (!('agentName' in child) || child.agentName === undefined) continue
    nestedAgentName = child.agentName
    break
  }
  const agentName =
    row.result?.agentName ??
    nestedAgentName
  // The worker's own id, which is what the face is keyed on: a name is not
  // unique per spawn and two workers can be told to run under one handle. It
  // rides the structured result (`transcriptProjector.ts` `agentId`), so a launch
  // ack has it immediately and a foreground worker only once it settles. A
  // running foreground card therefore draws by name first and adopts the id when
  // it lands, which does not move the face: the registry binds both to whichever
  // arrived first.
  const agentId = row.result?.agentId
  return {
    toolName: row.toolName === 'Task' ? 'Task' : 'Agent',
    status: row.status,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
    ...(input.run_in_background === true || row.toolName === 'ResumeAgent'
      ? { run_in_background: true }
      : {}),
    ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(!isLaunchRecord && row.agentCompletion !== null
      ? { hasCompletion: true, completionStatus: row.agentCompletion.status }
      : {}),
  }
}

function agentActivityTarget(child: ToolUseNestedRow): string {
  if (child.toolFamily !== 'bash') return deriveTarget(child)
  const str = (key: string): string | null => {
    const value = child.input[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  return (
    selectBashCardText(str('command'), str('description')).hover ??
    deriveTarget(child)
  )
}

/**
 * The running card's live signal: the subagent's most recent nested tool call.
 * Only full frames arrive for subagents (§4/S1 — no nested streaming), so the
 * LAST tool-use child IS what the worker is doing right now. Null until the
 * first one lands, which is the real "spawned but nothing yet" moment.
 */
export function agentActivityOf(row: ToolUseNestedRow): string | null {
  for (let index = row.children.length - 1; index >= 0; index -= 1) {
    const child = row.children[index]
    if (child === undefined || child.kind !== 'tool-use') continue
    // Peer tools carry their verb in a mark the activity line does not have, so
    // they supply a whole phrase and skip the prefix below — which would
    // otherwise print their raw PascalCase names at the user (§7), and print
    // `ListPeers` twice now that the call has a target of its own.
    const peerActivity = peerActivityText(child.toolName, child.input)
    if (peerActivity !== null) return peerActivity
    const target = agentActivityTarget(child)
    // `agentActivityTarget` falls back to the tool's OWN name for several families, and
    // already spells MCP as `server › tool`. Prefixing either prints the name
    // twice ("TodoWrite TodoWrite") and pushes the badge past its truncation.
    //
    // Bash is unprefixed for a different reason: its target is a sentence the
    // worker wrote about its own work, or failing that a shell command. Both
    // read as what is happening; "Bash" in front of either only spends the slot.
    return (
      target === child.toolName ||
      child.toolFamily === 'mcp' ||
      child.toolFamily === 'bash'
    )
      ? target
      : `${child.toolName} ${target}`
  }
  return null
}

/**
 * Nested TOOL CALLS only. The count this replaced ("N nested") counted every
 * child row, mixing the worker's prose turns in with its tool calls, so two
 * agents that did identical work could report different numbers.
 */
function agentToolCallCount(row: ToolUseNestedRow): number {
  return row.children.reduce(
    (total, child) => (child.kind === 'tool-use' ? total + 1 : total),
    0,
  )
}

/**
 * The card's ONE right-hand slot, which holds exactly one thing: while a worker
 * is live it says what the worker is doing, and once it settles it says what the
 * worker cost. Never both, never a state word, and it may be absent.
 *
 * Counting nested rows is the last resort when restored result usage is absent.
 */
export function agentProgressBadge(
  row: ToolUseNestedRow,
  state: AgentStateKey,
): string | null {
  const activity = agentActivityOf(row)
  if (state === 'running') return activity ?? 'starting'
  // A BACKGROUNDED agent's card says so instead of naming an activity. Its
  // steps now nest under the card (`runAgent` publishes them out of turn), but
  // the launch ack settles the tool use at once, so this word is the card's only
  // statement that the worker left the turn.
  //
  // It says so itself now. The redesign took the lifecycle word off the card
  // (2026-08-19), so with the slot empty and the face turned away this card
  // carried no statement at all that the worker went to the background.
  //
  // A LAUNCH RECORD says `launched`, not `backgrounded`. Both are state
  // `background` and both used to be told apart by the face alone — teal for the
  // ack, blue for a run genuinely under way. The face carries identity now
  // (2026-08-21), so the distinction moved into the word, where it says what it
  // means instead of relying on a reader knowing two shades of the same stamp.
  if (state === 'background') {
    const isLaunchRecord =
      (row.toolName === 'Agent' || row.toolName === 'Task') &&
      row.input.run_in_background === true
    return isLaunchRecord ? 'launched' : 'backgrounded'
  }
  const settledUsage = row.result?.agentUsage ?? null
  const toolCalls = settledUsage?.toolUses ?? agentToolCallCount(row)
  const parts: string[] = []
  if (toolCalls > 0) {
    parts.push(`${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`)
  }
  // Built independently of the call count: an agent that answered from context
  // has real token usage and zero tool calls, and gating both on the count
  // threw the engine's own totals away.
  //
  // `> 0`, not merely present: a missing count is persisted as a literal zero
  // engine-side (`totalTokensOverride ?? 0`,
  // `src/tools/AgentTool/agentToolUtils.ts:694`, whose sibling branch logs
  // `finalize_missing_usage`), and that zero survives the projector's
  // all-or-nothing narrowing as a valid number. Printing it renders "we never
  // got usage" as the claim "0 tokens", beside a worker that made 55 tool calls.
  //
  // A worker that did not FINISH drops the figure whatever its value: its
  // totals are a partial tally, and printing them beside a row that has just
  // said Failed or Stopped invites the reader to compare a broken run's cost
  // against a whole one's.
  const settledWhole = state !== 'failed' && state !== 'stopped'
  if (settledWhole && settledUsage && settledUsage.totalTokens > 0) {
    parts.push(`${compactCount(settledUsage.totalTokens)} tokens`)
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * The model this worker actually ran on, transcript-plane only.
 *
 * Two sources for the same fact at two moments in a run: a SETTLED worker's own
 * structured result carries `model` (`AgentToolResult.model`), and a RUNNING one
 * has no result yet, so it is read off the `model` its nested assistant frames
 * carry. Both replay from history; neither joins a live snapshot (D2 §4).
 *
 * The first nested frame, not the last: it is the same value for the whole run
 * (the engine resolves the subagent's model once), and reading forward keeps the
 * card from re-rendering a different string as children arrive.
 */
export function agentModelOf(row: ToolUseNestedRow): string | null {
  const settled = row.result?.agentModel
  if (settled !== undefined) return settled
  for (const child of row.children) {
    if (!('model' in child) || child.model === undefined) continue
    return child.model
  }
  return null
}

/**
 * The Codex account this worker is holding, or null.
 *
 * A LIVE join, and the only thing on the card that is not transcript-plane. It is
 * deliberate and operator-ruled (2026-08-19): the account is the one fact a
 * reader needs to answer "which of my accounts is this burning", and the
 * transcript carries no such field. The join key needs no new plumbing on either
 * side — `LeaseOwnerRow.ownerId` IS the subagent's `agentId`
 * (`protocol.ts` JOIN KEY note), and the Agent tool's own structured result
 * carries that `agentId` for both the sync and the background paths
 * (`AgentTool.tsx:1306` async ack).
 *
 * TWO sources, live first. The lease join answers while the worker is running
 * and follows it across a failover; it goes null the moment the worker finishes,
 * because `releaseCodexLease` DELETES the entry rather than marking it, so the
 * settled answer comes from the result's own stamp (`agentAccount`) instead.
 * Live is preferred over the stamp for the one case where they can disagree: a
 * background worker's stamp is written at dispatch and cannot be amended.
 *
 * Null is still the ORDINARY case and must stay silent, not blank: an
 * Anthropic-path worker holds no Codex lease at all, and a run recorded before
 * the engine stamped its result carries neither. The account renders when it is
 * knowable and is absent otherwise; nothing on the row claims a slot that can
 * empty.
 */
export function agentAccountLabel(
  row: ToolUseNestedRow,
  leases: LeaseSnapshot | null,
): string | null {
  const lease =
    selectLeaseForOwner(leases, row.result?.agentId ?? null) ??
    selectLeaseForLabel(leases, agentLeaseLabelOf(row))
  if (lease !== null) return leaseAccountShortLabel(lease)
  const stamped = row.result?.agentAccount
  return stamped === undefined ? null : leaseAccountShortLabel(stamped)
}

/**
 * The label this row's lease was registered under: the Agent tool's own
 * `description` argument, which `registerWorkerCodexLease` passes straight
 * through as `ownerLabel` (`src/tools/AgentTool/AgentTool.tsx:1502`).
 *
 * Read raw off the input rather than from `deriveTarget`, which is display text
 * and may be shortened or fall back to other fields — the join needs the exact
 * string the engine registered. A ResumeAgent row has no `description` and needs
 * none: the projector resolves its `agentId` from the input, so it joins on the
 * key above.
 */
function agentLeaseLabelOf(row: ToolUseNestedRow): string | null {
  const description = row.input.description
  return typeof description === 'string' && description.length > 0
    ? description
    : null
}


/** Result identity and the explicit ResumeAgent target are transcript-owned. */
export function agentIdOf(row: ToolUseNestedRow): string | null {
  if (row.toolName === 'ResumeAgent' && typeof row.input.agentId === 'string') return row.input.agentId
  if (row.result?.agentId) return row.result.agentId
  return null
}

/** A resumed run owns its completion totals, never the original launch's totals. */
export function agentUsageOf(row: ToolUseNestedRow): { totalTokens: number; toolUses: number } | null {
  return row.toolName === 'ResumeAgent' ? row.agentCompletion?.usage ?? null : row.result?.agentUsage ?? null
}
