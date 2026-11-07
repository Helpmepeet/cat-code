/**
 * The words of one tool call in Focus: the single source for the step head, the
 * rolling rows and a settled named step. Pure data, no JSX.
 *
 *   focusedCallPhase(call, signalled)  where the call is in its life
 *   focusedCallLine(call, ctx)         the line to draw for it
 *   focusedCallMark(call)              mark glyph and colour class alone
 *   backgroundAgentState(row)          vocabulary state of a background Agent/Task launch
 *
 * A line renders as `<verb> <target>` plus ` · <detail>` in the sans face when
 * `detail` is set. `verbTone` says how the verb is dressed: 'live' shimmers,
 * 'queued' is dimmed, 'warn' is an attention colour that must NOT shimmer, and
 * null is plain. `targetFace` is 'mono' for code-like targets (paths, commands)
 * and 'sans' for prose (names, titles, prompts). An empty `verb` means the
 * target speaks for itself (Codex computer-use step titles) and is drawn alone.
 * `background` marks a launch that outlives its tool result ("in background", or how it ended).
 *
 * Phases: preparing, queued, reviewing, approval, running (the tool's present
 * verb), done and failed (its past verb), stopped, blocked.
 */
import type { TasksSnapshot } from '../../shared/protocol.js'
import { deriveAgentDisplayVocabulary } from './agentIdentity.js'
import { askUserQuestionTranscriptPresentation } from './askUserQuestionTranscript.js'
import type { FocusedCall } from './focusedLive.js'
import { parseListPeersResult } from './listPeersCard.js'
import { PEER_TONE_CLASS, peerToolPresentation } from './peerSurfaces.js'
import { FAMILY_STYLE } from './toolCardPalette.js'
import { agentToolSourceOf } from './transcriptAgent.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'
import { deriveTarget, peerTargetFragment, toolSearchCardView } from './transcriptToolTarget.js'

export type FocusedCallPhase = 'preparing' | 'queued' | 'reviewing' | 'approval' | 'running' | 'done' | 'failed' | 'stopped' | 'blocked'

export type FocusedCallContext = {
  /** Whether live activity reports have started arriving; before that a pending call counts as running. */
  signalled: boolean
  /** Project folder trimmed from path targets, as Full does. */
  cwd: string | null
  tasks: TasksSnapshot | null
  /** Top-level rows of the turn, to name a background task by the call that started it. */
  turnRows: readonly NestedTranscriptRow[]
}

export type FocusedCallLine = {
  phase: FocusedCallPhase
  verb: string
  verbTone: 'live' | 'queued' | 'warn' | null
  target: string
  targetFace: 'mono' | 'sans'
  /** Rendered after the target as " · detail" in the sans face. */
  detail: string | null
  mark: string
  markClass: string
  background: { state: 'running' | 'failed' | 'stopped' } | null
}

/** The user turned the question down: an answer, not a failure (Full says "Declined"). */
export function isDeclinedQuestion(row: NestedToolUseRow): boolean {
  return row.toolName === 'AskUserQuestion' && row.status === 'error' &&
    askUserQuestionTranscriptPresentation(row.toolName, row.input, row.status, row.result)?.state === 'declined'
}

export function focusedCallPhase(call: FocusedCall, signalled: boolean): FocusedCallPhase {
  if (call.preparing) return 'preparing'
  if (call.status === 'success' || isDeclinedQuestion(call)) return 'done'
  if (call.status === 'cancelled') return 'stopped'
  if (call.status === 'error') return call.autoModeReview?.outcome === 'blocked' ? 'blocked' : 'failed'
  // A blocking question reaches the user through the permission queue; it waits on an answer, not an approval.
  if (call.awaitingApproval && call.toolName !== 'AskUserQuestion') return 'approval'
  if (call.activity?.phase === 'reviewing') return 'reviewing'
  return call.activity?.phase === 'executing' || !signalled ? 'running' : 'queued'
}

type Words = { present: string; past: string; target: string; face?: 'mono' | 'sans'; detail?: string | null }

const VERBS: Record<string, readonly [string, string]> = {
  read: ['Reading', 'Read'], edit: ['Editing', 'Edited'], write: ['Writing', 'Wrote'], grep: ['Searching', 'Searched'],
  bash: ['Running', 'Ran'], notebook: ['Editing', 'Edited'], web: ['Fetching', 'Fetched'],
}

const NO_TASK = 'a background task'

function inputString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const withoutAt = (value: string | null): string => (value ?? '').replace(/^@/, '')

/** `mcp__cua-driver__get_window_state` reads `cua-driver · get window state`. */
function mcpTarget(toolName: string): string {
  const [, server, ...rest] = toolName.split('__')
  if (!server) return toolName
  return rest.length > 0 ? `${server} · ${rest.join('__').replace(/_/g, ' ')}` : server
}

const LAUNCH_ID = /background with ID: ([\w-]+)/
const launchesByRows = new WeakMap<readonly NestedTranscriptRow[], ReadonlyMap<string, string>>()

/** What each background launch in the turn was, by the task id its result reported; built once per rows. */
function turnLaunches(rows: readonly NestedTranscriptRow[]): ReadonlyMap<string, string> {
  const cached = launchesByRows.get(rows)
  if (cached) return cached
  const launches = new Map<string, string>()
  for (const row of rows) {
    if (row.kind !== 'tool-use') continue
    if (row.toolFamily === 'bash') {
      const id = LAUNCH_ID.exec(row.result?.content ?? '')?.[1]
      const command = inputString(row.input, 'command')
      if (id !== undefined && command !== null) launches.set(id, command)
    } else if (row.toolFamily === 'agent' && row.result?.agentId) {
      const description = inputString(row.input, 'description')
      if (description !== null) launches.set(row.result.agentId, description)
    }
  }
  launchesByRows.set(rows, launches)
  return launches
}

function taskLabel(call: FocusedCall, ctx: FocusedCallContext): string {
  const id = inputString(call.input, 'task_id') ?? inputString(call.input, 'shell_id')
  if (id === null) return call.result?.taskOutput?.description || NO_TASK
  const job = ctx.tasks?.focusedBashJobs?.find(job => job.id === id) ?? ctx.tasks?.items.find(item => item.id === id)
  return job?.label || turnLaunches(ctx.turnRows).get(id) || call.result?.taskOutput?.description || NO_TASK
}

function askWords(call: FocusedCall): Words {
  const questions = call.input.questions
  const first = Array.isArray(questions) && typeof questions[0]?.question === 'string' ? questions[0].question as string : ''
  const presentation = askUserQuestionTranscriptPresentation(call.toolName, call.input, call.status, call.result)
  const answer = presentation?.items[0]?.answer
  return { present: 'Waiting for your answer', past: presentation?.state === 'declined' ? 'Declined' : 'Asked', target: first, face: 'sans', detail: answer ? answer : null }
}

function callWords(call: FocusedCall, ctx: FocusedCallContext): Words {
  const { toolName, input } = call
  const str = (key: string) => inputString(input, key)
  switch (toolName) {
    case 'WebSearch': case 'web_search':
      return str('query') ? { present: 'Searching the web for', past: 'Searched the web for', target: str('query')! }
        : { present: 'Searching the web', past: 'Searched the web', target: '' }
    case 'ResumeAgent':
      return { present: 'Resuming', past: 'Resumed', target: withoutAt(str('agentId')), face: 'sans', detail: str('prompt') ? peerTargetFragment(str('prompt')!) : null }
    case 'SendMessage':
      return { present: 'Messaging', past: 'Messaged', target: withoutAt(str('to')), face: 'sans', detail: str('summary')?.trim() || null }
    case 'ToolSearch':
      return { present: 'Loading', past: 'Loaded', target: toolSearchCardView(call).target }
    case 'TaskOutput':
      return { present: 'Waiting on', past: 'Checked on', target: taskLabel(call, ctx), face: 'sans' }
    case 'TaskStop':
      return { present: 'Stopping', past: 'Stopped', target: taskLabel(call, ctx), face: 'sans' }
    case 'Announce':
      return { present: 'Posting notice', past: 'Posted notice', target: str('doing') ? peerTargetFragment(str('doing')!) : '', face: 'sans' }
    case 'ListPeers': {
      const parsed = call.result && !call.result.isError ? parseListPeersResult(call.result.content) : null
      // An empty roster comes back as plain text (`listPeersTool.ts`), not as JSON.
      const empty = parsed?.peers.length === 0 || (call.result?.isError === false && call.result.content.startsWith('No other sessions'))
      const target = empty ? 'no open sessions' : parsed === null ? '' : parsed.peers.map(peer => peer.name).join(', ')
      return { present: 'Listing peers', past: 'Listed peers', target, face: 'sans' }
    }
    case 'ReadPeer': {
      const query = str('query')?.trim()
      return { present: 'Reading', past: 'Read', target: str('peer') ?? 'a peer', face: 'sans', detail: query ? peerTargetFragment(query) : null }
    }
    case 'CreatePeer': {
      const prompt = str('prompt') ? peerTargetFragment(str('prompt')!) : ''
      const created = call.result?.createdPeer?.name
      return created
        ? { present: 'Creating a session', past: 'Created', target: created, face: 'sans', detail: prompt || null }
        : { present: 'Creating a session', past: 'Created a session', target: prompt, face: 'sans' }
    }
    case 'GenerateImage':
      return { present: 'Generating image', past: 'Generated image', target: str('prompt') ?? '', face: 'sans' }
    case 'AskUserQuestion':
      return askWords(call)
    case 'Agent': case 'Task': {
      const name = deriveAgentDisplayVocabulary(agentToolSourceOf(call)).identity.name
      return { present: 'Delegating', past: 'Delegated', target: deriveTarget(call, ctx.cwd), detail: name }
    }
  }
  switch (call.toolFamily) {
    case 'mcp':
      return { present: 'Using', past: 'Used', target: mcpTarget(toolName) }
    case 'computer':
      return { present: '', past: '', target: deriveTarget(call, ctx.cwd), face: 'sans' }
    default: {
      const [present, past] = VERBS[call.toolFamily] ?? ['Using', 'Used']
      return { present, past, target: deriveTarget(call, ctx.cwd) }
    }
  }
}

/** Mark glyph and colour class: the family's own, with Focus's and the peer tools' exceptions. */
export function focusedCallMark(call: FocusedCall): { mark: string; markClass: string } {
  if (call.toolName === 'AskUserQuestion') return { mark: '?', markClass: 'text-accent' }
  if (call.toolName === 'ToolSearch') return { mark: '⌕', markClass: FAMILY_STYLE.grep.color }
  const peer = peerToolPresentation(call.toolName, call.input)
  if (peer !== null) return { mark: peer.mark, markClass: PEER_TONE_CLASS }
  const style = FAMILY_STYLE[call.toolFamily]
  return call.toolFamily === 'write' ? { mark: '±', markClass: style.color } : { mark: style.mark, markClass: style.color }
}

/** A background Agent/Task launch's vocabulary state; null for anything else. */
export function backgroundAgentState(row: NestedToolUseRow): 'running' | 'failed' | 'stopped' | null {
  if ((row.toolName !== 'Agent' && row.toolName !== 'Task') || row.input.run_in_background !== true) return null
  switch (deriveAgentDisplayVocabulary(agentToolSourceOf(row)).state.key) {
    case 'background': case 'running': return 'running'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return null
  }
}

function backgroundOf(call: FocusedCall, ctx: FocusedCallContext): FocusedCallLine['background'] {
  if (call.toolFamily === 'bash') {
    // Focused jobs leave out a healthy running service, so the task list, keyed by
    // the id the launch reported, answers for those.
    const id = call.input.run_in_background === true ? LAUNCH_ID.exec(call.result?.content ?? '')?.[1] : undefined
    const status = ctx.tasks?.focusedBashJobs?.find(job => job.toolUseId === call.toolUseId)?.status ??
      (id === undefined ? undefined : ctx.tasks?.items.find(item => item.id === id)?.status)
    const state = status === 'running' ? 'running' : status === 'failed' ? 'failed' : status === 'killed' ? 'stopped' : null
    return state === null ? null : { state }
  }
  const state = backgroundAgentState(call)
  return state === null ? null : { state }
}

function phaseVerb(phase: FocusedCallPhase, words: Words, asking: boolean): readonly [string, FocusedCallLine['verbTone']] {
  switch (phase) {
    case 'preparing': return ['Preparing', 'live']
    case 'approval': return ['Waiting for approval', 'warn']
    case 'stopped': return ['Stopped', null]
    case 'blocked': return ['Blocked', null]
    case 'done': case 'failed': return [words.past, null]
    // The question is waiting on the user, so no engine phase changes that.
    default: return asking ? ['Waiting for your answer', 'queued']
      : phase === 'queued' ? ['Queued', 'queued']
      : phase === 'reviewing' ? ['Reviewing', 'live']
      : [words.present, 'live']
  }
}

export function focusedCallLine(call: FocusedCall, ctx: FocusedCallContext): FocusedCallLine {
  const phase = focusedCallPhase(call, ctx.signalled)
  const words = callWords(call, ctx)
  const mark = focusedCallMark(call)
  const [verb, verbTone] = phaseVerb(phase, words, call.toolName === 'AskUserQuestion')
  return { phase, verb, verbTone, target: words.target, targetFace: words.face ?? 'mono', detail: words.detail ?? null,
    ...mark, background: backgroundOf(call, ctx) }
}
