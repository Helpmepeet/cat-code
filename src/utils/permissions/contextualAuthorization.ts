import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { feature } from 'bun:bundle'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { recordToolReview } from '../../app-runtime/toolActivity.js'
import { persistAutoModeReview } from '../../app-runtime/autoModeReviewPersistence.js'
import type { AutoModeReview } from '../../app-runtime/autoModeReviewContract.js'
import { redactSecrets, scanForSecrets } from '../../services/teamMemorySync/secretScanner.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { isFilePatchToolName, FILE_PATCH_TOOL_NAME } from '../../tools/FilePatchTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { getBashExecutionSettings, type BashToolInput } from '../../tools/BashTool/BashTool.js'
import { codeModeToolPrincipal } from '../../tools/REPLTool/codeModeTools.js'
import { workspaceInstructionsForReview } from '../claudemd.js'
import { getPatchFromContents } from '../diff.js'
import { isCompleteUnboundedRead } from '../fileStateCache.js'
import { getCwd } from '../cwd.js'
import { getPreparedFileMutationSet } from '../fileAuthorization.js'
import { expandPath } from '../path.js'
import { getSourcedAutoModeInstructions } from '../settings/settings.js'
import { buildContextualReview, contextualReviewerProfile, sendContextualReview } from './contextualReviewer.js'
import { CONTEXTUAL_REVIEW_VERSION } from './contextualReviewPrompt.js'
import { readContextualAuthority, recentShellRuns, resolveContextualPeerParent } from './contextualAuthority.js'
import { createDenialTrackingState, DENIAL_LIMITS, persistDenialState, recordDenial, recordSuccess } from './denialTracking.js'
import type { ContextualEvidence } from './contextualReviewPrompt.js'
import { recordAutoModeOutcome } from './autoModeMeta.js'
import { collectPermissionDecisionContexts } from './permissionDecisionContext.js'
import { getConfiguredAutoModeModel } from './yoloClassifier.js'

type Input = Record<string, unknown>
type ReviewMode = 'shadow' | 'experimental'
const readOnlyTools = new Set(['Read', 'Glob', 'Grep', 'LS', 'ListPeers', 'ReadPeer',
  'GetGoal', 'CronList', 'LSP', 'ListProjects', 'TaskList', 'TaskGet', 'TaskOutput', 'ToolSearch', 'BrowserRead', 'BrowserScreenshot'])

function isMcpTool(tool: Tool): boolean {
  return Boolean(tool.isMcp || tool.mcpInfo)
}

export function mayChangeState(tool: Tool | undefined, input?: Input): boolean {
  return !tool || isMcpTool(tool) || (!readOnlyTools.has(tool.name) && !(tool.name === 'BrowserAct' && input?.action === 'scroll'))
}

const toolEffects: Readonly<Record<string, string>> = {
  Bash: 'Execute the complete shell command in the effective working directory.',
  Edit: 'Replace matching text in the resolved file.',
  Write: 'Create or overwrite the resolved file.',
  [FILE_PATCH_TOOL_NAME]: 'Apply the complete patch, including each file addition, edit, move, or deletion.',
  [NOTEBOOK_EDIT_TOOL_NAME]: 'Insert, replace, or delete the specified cell in the notebook.',
  Read: 'Read data from the resolved file.',
  REPL: 'Admit the complete submitted source to the isolated Script interpreter. Each child is authorized separately.',
  Agent: 'Launch an agent with the specified assignment and capabilities.',
  CreatePeer: 'Create a new peer and deliver the specified opening assignment.',
  SendToPeer: 'Deliver the specified message to a workspace peer. This can wake that session and start a turn.',
  Announce: 'Replace this session’s scope notice on the workspace peer roster. Peers can read the notice when they list the roster. Posting executes no edits and grants no file permissions.',
}

function projectAction(tool: Tool, input: Input, context: ToolUseContext) {
  const cwd = getCwd()
  const mcp = isMcpTool(tool)
  const effectKey = isFilePatchToolName(tool.name) ? FILE_PATCH_TOOL_NAME : tool.name
  const effect = !mcp && Object.hasOwn(toolEffects, effectKey) ? toolEffects[effectKey] : undefined
  const parameters = { ...input }
  let execution: Input | undefined
  if (!mcp && tool.name === 'Bash') {
    // Descriptions describe the agent's intent. Execution flags are engine data.
    const { description: _description, ...bash } = input as BashToolInput
    return { cwd, effect, input: bash, execution: {
      ...getBashExecutionSettings(input as BashToolInput, Boolean(context.inlineCommand), !context.agentId),
      sandboxOverrideRequested: input.dangerouslyDisableSandbox === true,
      workLifetime: input.work_lifetime ?? 'finite',
    } }
  }
  const fileParameter = tool.name === NOTEBOOK_EDIT_TOOL_NAME ? 'notebook_path' : 'file_path'
  if (!mcp && (['Read', 'Edit', 'Write'].includes(tool.name) || tool.name === NOTEBOOK_EDIT_TOOL_NAME) &&
      typeof input[fileParameter] === 'string') {
    const path = expandPath(input[fileParameter], cwd)
    parameters[fileParameter] = path
    let target = path
    try { target = realpathSync(path) } catch {
      try { target = join(realpathSync(dirname(path)), basename(path)) } catch { /* parent may also be new */ }
    }
    execution = { target, ...(tool.name === 'Write' && { operation: existsSync(path) ? 'overwrite' : 'create' }) }
  }
  if (!mcp && isFilePatchToolName(tool.name)) {
    const prepared = getPreparedFileMutationSet(context, tool.name, input)
    if (prepared) execution = { targets: [...prepared.byPath].map(([path, target]) => ({
      path, resolved: target.actualPath ?? target.canonicalPath,
    })) }
  }
  if (!mcp && tool.name === 'REPL') {
    execution = { background: input.run_in_background === true, interpreter: context.agentId ?? 'session' }
  }
  if (mcp) {
    execution = { server: tool.mcpInfo?.serverName, serverTool: tool.mcpInfo?.toolName }
  }
  return { cwd, input: parameters, effect, execution }
}

function containsCredentialMaterial(value: string): boolean {
  return /\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{15,}|gh[pousr]_[a-z0-9]{20,}|eyJ[a-z0-9_-]{15,}\.[a-z0-9_-]{10,}|(?:authorization:\s*bearer|(?:access_token|api[_-]?key|password)(?:\\?["'])?\s*[:=])\s*(?:\\?["'])?[^\s"'\\]{8,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
    scanForSecrets(value).length > 0
}

// Keep the surrounding instruction (including any withdrawal). Unrecognized
// formats still take the existing human-only path in the final payload scan.
function redactOldText(text: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(text)) return text
  return redactSecrets(text)
    .replace(/\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{15,}|gh[pousr]_[a-z0-9]{20,}|eyJ[a-z0-9_-]{15,}\.[a-z0-9_-]{10,}(?:\.[a-z0-9_-]+)?)/giu, '[…]')
}

function redactHistory(rows: ContextualEvidence['conversation']) {
  const latest = rows.findLast(row => row.origin === 'operator')
  return rows.map(row => row === latest ? row : { ...row, text: redactOldText(row.text),
    ...(row.proposal && { proposal: { ...row.proposal, text: redactOldText(row.proposal.text) } }) })
}

// Roster text is visible to other sessions. Only ordinary development vocabulary
// and workspace paths take the automatic route; open-ended prose goes to review.
const scopeWords = new Set((
  'a the this and or for to of in on with from under before after only may will no ' +
  'work working inspect inspecting investigate investigating check checking read reading review reviewing ' +
  'fix fixing update updating change changing add adding remove removing edit editing implement implementing ' +
  'run running verify verifying test testing debug debugging build building clean cleaning refactor refactoring ' +
  'docs documentation source code project workspace shared local native sandbox sandboxed browser chrome codex cat ' +
  'launch launches layout renderer desktop app ui api tool tools script scripts runner helper helpers ' +
  'regression tests checks file files config configuration component components module modules permission permissions ' +
  'changes edits writes reads paths scoped read-only focused overlapping existing unrelated preserve isolated ' +
  'offline checks coordination peer session engine runtime sidecar implementation smoke fixtures validation ' +
  'implement notifications dock badge end decision os active queued corrections queue policy owner map ' +
  'sidebar tab activity selectors indicators include subagents working plan audit integration results'
).split(' '))

function routineScopeNotice(input: Input, cwd: string): boolean {
  if (typeof input.doing !== 'string' || containsCredentialMaterial(JSON.stringify(input))) return false
  const touches = input.touches ?? []
  if (!Array.isArray(touches)) return false
  let root: string
  try { root = realpathSync(cwd) } catch { return false }
  const inWorkspace = (path: string) => {
    const rel = relative(root, path)
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) && !rel.split('/').some(part => part.startsWith('.'))
  }
  const components = new Set<string>()
  const validTouches = touches.every(touch => {
    if (typeof touch !== 'string' || !/^[a-z0-9_./ *~-]+$/iu.test(touch) || touch.split('/').includes('..')) return false
    const checkedPath = (entry: string) => {
      const path = expandPath(entry, cwd)
      if (!inWorkspace(path)) return false
      // A conventional test/source glob is a displayed scope, never expanded.
      const literal = /^\*(?:\.(?:layout|test|spec))?\.(?:[jt]sx?|css|md|json|py|txt)$/iu.test(basename(path))
        ? dirname(path) : path
      try {
        if (!inWorkspace(realpathSync(literal))) return false
        const name = relative(root, literal).replace(/([a-z])([A-Z])/gu, '$1 $2')
        for (const part of name.toLowerCase().split(/[^a-z]+/u)) if (part.length > 1) components.add(part)
        return true
      } catch { return false }
    }
    if (checkedPath(touch)) return true
    const [area, ...words] = touch.split(/ +/u)
    return words.length > 0 && checkedPath(area!) && words.every(word => scopeWords.has(word.toLowerCase()))
  })
  if (!validTouches) return false
  const routineText = (text: unknown) => typeof text === 'string' && /^[a-z0-9_ .,;:()/*~+-]+$/iu.test(text) &&
    text.split(/[ ,;:()]+/u).every(token => {
      const word = token.replace(/\.$/u, '')
      return !word || touches.includes(word) || word.toLowerCase().split(/[-/]/u)
        .every(part => scopeWords.has(part) || components.has(part))
    })
  return routineText(input.doing) && (input.note === undefined || routineText(input.note))
}

function readMode(): ReviewMode | undefined {
  if (!feature('AUTO_MODE_CONTEXTUAL_REVIEW')) return undefined
  const value = process.env.CLAUDE_CODE_CONTEXTUAL_AUTO_MODE
  const session = process.env.CATCODE_SIDECAR_SESSION_ID
  const selected = process.env.CLAUDE_CODE_CONTEXTUAL_AUTO_MODE_SESSION_ID
  if (value === 'legacy' || (selected && selected !== session)) return undefined
  if (value === 'shadow' || value === 'experimental') return value
  return 'experimental'
}

export type ContextualAutoAttempt = NonNullable<Awaited<ReturnType<typeof createContextualAttempt>>>

export async function createContextualAttempt(
  tool: Tool,
  input: Input,
  context: ToolUseContext,
  assistant: AssistantMessage,
  toolUseId: string,
) {
  const mode = readMode()
  if (!mode) return undefined
  const mcp = isMcpTool(tool)
  // The engine's typed question receipt authorizes its display and answer.
  // Any action proposed in response still goes through its own permission check.
  if (!mcp && tool.name === ASK_USER_QUESTION_TOOL_NAME) return undefined
  const snapshot = structuredClone(input)
  const action = projectAction(tool, snapshot, context)
  const peerParent = await resolveContextualPeerParent(context,
    !mcp && tool.name === 'Announce' ? context.lookupLegacyPeerCreator : undefined)
  let authority = readContextualAuthority(context, peerParent)
  const policy: ToolPermissionContext = structuredClone(context.getAppState().toolPermissionContext)
  const instructions = getSourcedAutoModeInstructions()
  const principal = codeModeToolPrincipal(tool, context)
  const { cellId, generation } = assistant.codeMode ?? {}
  // Script admission grants the isolated interpreter a single invocation.
  // The calls it submits carry their own delegated mutation gate.
  const delegatedMutation = authority.delegated && mayChangeState(tool, snapshot) && (mcp || tool.name !== 'REPL')
  const latestOperator = authority.conversation.findLast(row => row.origin === 'operator' && row.id)
  const newOperatorTurn = latestOperator && !context.messages.some(row => row.uuid === latestOperator.id)
  const followUps = [...authority.pendingConversation, ...(newOperatorTurn && latestOperator ? [latestOperator] : [])]
  // A queued restriction may cover a read as well as a write. Route it to the
  // reviewer for scope; a normal question can drain with an already-approved read.
  const possibleReadWithdrawal = followUps.some(({ text }) =>
    /\b(?:stop|cancel|pause|hold off|off limits|off-limits|withdraw|revoke|leave .{0,60} alone)\b|\b(?:do not|don['’]t|never|avoid|no (?:more|further))\s+(?:read|access|open|inspect|search|look|use|run|touch|scroll|take|capture)/iu.test(text))
  let reviewedInstructions = false
  let attemptId = randomUUID()
  let startedAt = Date.now()
  let review: Promise<PermissionDecision> | undefined
  let actionAllowed = false
  let requiresHuman = false
  let humanAllowed = false
  let used = false
  let lastOutcome: AutoModeReview['outcome'] | undefined
  let reviewer: NonNullable<AutoModeReview['reviewer']> = { kind: 'contextual', version: CONTEXTUAL_REVIEW_VERSION }
  let boundProjection: { value: unknown } | undefined

  function currentProjection(): unknown {
    try { return tool.toAutoClassifierInputForUse?.(input, toolUseId) }
    catch { return undefined }
  }

  function unchangedAction(candidate: Input, releasedContext: ToolUseContext): boolean {
    const liveMcp = mcp && releasedContext.options.getMcpRuntimeSnapshot?.()
    const principalContext = liveMcp ? { ...releasedContext, options: { ...releasedContext.options, mcpClients: [...liveMcp.clients] } } : releasedContext
    return isDeepStrictEqual(candidate, snapshot) &&
      isDeepStrictEqual(releasedContext.getAppState().toolPermissionContext, policy) &&
      isDeepStrictEqual(getSourcedAutoModeInstructions(), instructions) &&
      codeModeToolPrincipal(tool, principalContext) === principal &&
      (!boundProjection || isDeepStrictEqual(currentProjection(), boundProjection.value)) &&
      isDeepStrictEqual(projectAction(tool, candidate, releasedContext), action)
  }

  function current(candidate: Input, releasedContext: ToolUseContext): boolean {
    const latest = readContextualAuthority(releasedContext, peerParent)
    return !latest.stopped && !latest.pendingOperatorInput && isDeepStrictEqual(latest, authority) &&
      unchangedAction(candidate, releasedContext)
  }

  // Only the operator's words can be refreshed. A change of tool, principal,
  // policy or assignment still invalidates the attempt.
  function refreshInstructions(): boolean {
    const latest = readContextualAuthority(context, peerParent)
    if (latest.stopped || latest.pendingOperatorInput || !unchangedAction(input, context) ||
        latest.actor !== authority.actor || latest.verifiedSource !== authority.verifiedSource ||
        !isDeepStrictEqual(latest.assignment, authority.assignment) ||
        !isDeepStrictEqual(latest.conversation.slice(0, authority.conversation.length), authority.conversation)) return false
    // While the queue drains, the same message can briefly be absent from
    // both views. Its withdrawal must not disappear from a second review.
    const visible = [...latest.pendingConversation, ...latest.conversation]
    if (authority.pendingConversation.some(entry => !visible.some(row =>
      row.origin === 'operator' && row.text === entry.text && (!entry.id || row.id === entry.id || row.submittedId === entry.id)))) return false
    authority = latest
    return true
  }

  function needsInstructionReview(): boolean {
    // A busy prompt drains at the end of the tool round. Reads already allowed
    // under this snapshot may finish it; later authority changes still fence release.
    return (!reviewedInstructions && (possibleReadWithdrawal || mayChangeState(tool, snapshot) && followUps.length > 0)) ||
      !isDeepStrictEqual(readContextualAuthority(context, peerParent), authority)
  }

  function emit(outcome: AutoModeReview['outcome'], reason?: string) {
    if (mode !== 'experimental') return
    lastOutcome = outcome
    const event: AutoModeReview = { type: 'tool.review', toolUseId, attemptId, startedAt, outcome,
      reviewer,
      ...(outcome !== 'reviewing' && { completedAt: Math.max(startedAt, Date.now()) }),
      ...(reason && { reason }) }
    persistAutoModeReview(event)
    recordToolReview(event)
  }

  function routineNoticeDecision(): PermissionDecision | undefined {
    if (mcp || tool.name !== 'Announce' || !authority.verifiedSource ||
        (authority.delegated && !authority.assignment?.parentAnchor) ||
        authority.stopped || authority.pendingOperatorInput || needsInstructionReview()) return undefined
    const operatorText = [...(authority.assignment?.parent ?? []), ...authority.conversation]
      .filter(row => row.origin === 'operator').map(row => row.text)
    const restrictions = instructions.flatMap(row => [...(row.soft_deny ?? []), ...(row.hard_deny ?? [])])
    if (/(?:^|[.!?]\s+)(?:keep (?:this|this (?:task|work|investigation)) private|(?:do not|don't) (?:announce (?:this|this task)|post (?:a |the )?scope notice))[.!]?$/iu.test(operatorText.at(-1) ?? '')) {
      const reason = 'You asked to keep this work off the workspace roster.'
      return { behavior: 'deny', message: reason, decisionReason: { type: 'other', reason } }
    }
    // Other audience constraints may depend on the task. The ordinary GUI
    // posting policy concerns a different destination from the workspace roster.
    const audience = /\b(?:privat\w*|confidential\w*|secret\w*|disclos\w*|announc\w*|roster|peers?|share|sharing|broadcast|notify|quiet\w*|tell|mention|between us|to yourself)\b/iu
    const workspace = workspaceInstructionsForReview(context.autoModeInstructionContext) ?? ''
    const standingNoticeRule = /(?:do not|never|must not|avoid|ask before|only|don't)[^.!?\n]{0,100}\b(?:announc\w*|roster|post to peers|share with peers)\b|\b(?:announc\w*|roster)\b[^.!?\n]{0,80}(?:forbidden|prohibited|approval|private)/iu
    const mayRestrictNotice = (text: string) => {
      const scoped = text.replace(/\b(?:tell me|mention (?:it |this )?to me|private (?:method|field|function|class))\b/giu, '')
      return audience.test(scoped) || /\b(?:post(?:ing)?|silently|silent|under wraps|nothing else)\b/iu.test(scoped)
    }
    if ([...operatorText, authority.assignment?.text ?? ''].some(mayRestrictNotice) ||
        restrictions.some(text => audience.test(text)) || standingNoticeRule.test(workspace) ||
        !routineScopeNotice(input, action.cwd)) return undefined
    actionAllowed = true
    return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'mode', mode: 'auto' } }
  }

  function ask(reason: string, outcome: 'asking' | 'inconclusive' = 'asking'): PermissionDecision {
    requiresHuman = true
    humanAllowed = false
    if (mode === 'experimental') {
      emit(outcome, reason)
      recordAutoModeOutcome(toolUseId, outcome === 'inconclusive' ? 'automode-unavailable' : 'unanswered')
    }
    if (policy.shouldAvoidPermissionPrompts) return {
      behavior: 'deny', message: reason + ' Interactive approval is unavailable.',
      decisionReason: { type: 'asyncAgent', reason },
    }
    return { behavior: 'ask', humanOnly: true, message: reason, updatedInput: input,
      decisionReason: { type: 'classifier', classifier: 'auto-mode', reason } }
  }

  function stale(reason: string): PermissionDecision {
    emit('inconclusive', reason)
    return {
      behavior: 'deny', message: reason,
      decisionReason: { type: 'other', reason },
    }
  }

  function renewReview() {
    if (lastOutcome) {
      emit('inconclusive', 'New instructions require a fresh review of this action.')
      attemptId = randomUUID()
      startedAt = Date.now()
      reviewer = { kind: 'contextual', version: CONTEXTUAL_REVIEW_VERSION }
      lastOutcome = undefined
    }
    actionAllowed = false
  }

  async function reviewHeldAction(canRefresh = true): Promise<PermissionDecision> {
    if (authority.pendingOperatorInput) return stale('A user message is waiting to be applied.')
    if (!refreshInstructions()) return stale('The assignment or action changed before review.')
    reviewedInstructions = true
    if (delegatedMutation && !authority.verifiedSource) {
      return ask('This helper has no verified user assignment for the requested action.')
    }
    let toolDescription: string | undefined
    if (!action.effect) {
      try {
        toolDescription = (await tool.description(input, {
          isNonInteractiveSession: context.options.isNonInteractiveSession,
          toolPermissionContext: policy,
          tools: context.options.tools,
        })).trim()
      } catch { /* The reviewer still receives the tool principal and complete arguments. */ }
      if (!refreshInstructions()) return stale('The assignment or action changed before review.')
    }
    const effect = action.effect ?? 'Invoke the named tool with the supplied arguments.'
    const resolvedAction = currentProjection()
    if (resolvedAction !== undefined) boundProjection = { value: structuredClone(resolvedAction) }
    const source = workspaceInstructionsForReview(context.autoModeInstructionContext)
    const path = !mcp && tool.name === 'Write' && typeof input.file_path === 'string'
      ? expandPath(input.file_path, action.cwd) : undefined
    const previous = path && context.readFileState.get(path)
    const changedLines = path && previous && isCompleteUnboundedRead(previous) && typeof input.content === 'string'
      ? getPatchFromContents({ filePath: path, oldContent: previous.content, newContent: input.content }).flatMap(hunk => hunk.lines)
      : undefined
    const conversation = [...authority.conversation, ...authority.pendingConversation]
    const runs = recentShellRuns(context.getCurrentAutoModeMessages?.() ?? context.messages, conversation, context.contextualWorkerAssignment?.excluded)
    const evidence = {
      ...(toolDescription && { toolDescription }),
      ...(!mcp && tool.name === 'Bash' && typeof input.description === 'string' && { agentStatedPurpose: input.description }),
      ...(runs.length && { recentShellRuns: runs.map(run => run.proposedCommand && containsCredentialMaterial(run.proposedCommand)
        ? { ...run, proposedCommand: undefined } : run) }),
      action: { ...action, effect, attempt: toolUseId, actor: authority.actor,
        execution: { ...action.execution,
          ...(changedLines?.length && { changeSinceCompleteRead: {
            addedLines: changedLines.filter(line => line.startsWith('+')).length,
            removedLines: changedLines.filter(line => line.startsWith('-')).length,
          } }),
          ...(boundProjection && { resolvedAction: boundProjection.value }) },
        tool: tool.name, ...(cellId && generation && { script: { cellId, generation, source: context.contextualParentScriptSource } }) },
      assignment: authority.assignment?.parent
        ? { ...authority.assignment, parent: redactHistory(authority.assignment.parent) } : authority.assignment,
      conversation: redactHistory(conversation),
      priorDecisions: collectPermissionDecisionContexts(context.messages).slice(-16).map(decision => ({
        action: decision.toolName, outcome: decision.outcome,
      })),
      workspaceInstructions: source && redactOldText(source),
    }
    const profile = contextualReviewerProfile(getConfiguredAutoModeModel())
    const built = buildContextualReview(evidence, profile, instructions)
    if (!built) return ask('The complete action and applicable instructions exceed the Auto Mode review limit.')
    if (containsCredentialMaterial(JSON.stringify(evidence)) || containsCredentialMaterial(JSON.stringify(instructions))) {
      return ask('The action or its context may contain credentials.')
    }
    reviewer = { kind: 'contextual', version: CONTEXTUAL_REVIEW_VERSION, profile: { provider: profile.provider, model: profile.model,
      effort: profile.effort, promptDigest: built.promptDigest } }
    emit('reviewing')
    const result = await sendContextualReview({ ...built.options, agentId: context.agentId }, context.abortController.signal)
    if (result.status === 'valid') reviewer = { ...reviewer, verdict: result.verdict.decision }
    if (!current(input, context)) {
      if (canRefresh && refreshInstructions()) {
        renewReview()
        return reviewHeldAction(false)
      }
      return stale(context.abortController.signal.aborted
        ? 'The review was cancelled.' : 'The assignment or action changed during review.')
    }
    if (result.status !== 'valid') return ask('Auto Mode could not complete this review.', 'inconclusive')
    const { decision, rationale } = result.verdict
    const reason = containsCredentialMaterial(rationale) ? 'Auto Mode reviewed the proposed action.' : rationale
    if (decision === 'ask') return ask(reason)
    const decisionReason = { type: 'classifier' as const, classifier: 'auto-mode', reason }
    if (decision === 'deny') {
      if (mode === 'experimental') {
        const state = recordDenial(context.localDenialTracking ?? context.getAppState().denialTracking ?? createDenialTrackingState())
        persistDenialState(context, state)
        if (!policy.shouldAvoidPermissionPrompts && state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive) {
          return ask(`${state.consecutiveDenials} consecutive actions received a deny. Latest reason: ${reason}`)
        }
      }
      emit('blocked', reason)
      if (mode === 'experimental') recordAutoModeOutcome(toolUseId, 'automode-blocked')
      return { behavior: 'deny', message: reason, decisionReason }
    }
    emit('allowed', reason)
    actionAllowed = true
    return { behavior: 'allow', updatedInput: input, decisionReason }
  }

  return {
    id: toolUseId, mode, delegatedMutation, routineNoticeDecision,
    get requiresHuman() { return requiresHuman },
    review: () => review ??= reviewHeldAction(),
    needsInstructionReview,
    reviewFollowUp() {
      renewReview()
      return reviewHeldAction()
    },
    requireHuman(reason: string) { return ask(reason) },
    recordHuman(candidate: Input, replyContext: ToolUseContext) {
      if (requiresHuman && unchangedAction(candidate, replyContext)) humanAllowed = true
    },
    isCurrent: current,
    release(candidate: Input, releasedContext: ToolUseContext): boolean {
      if (used) return false
      if (!current(candidate, releasedContext) || (requiresHuman ? !humanAllowed : delegatedMutation && !actionAllowed)) {
        stale('The approval no longer matches the current action, assignment or permissions.')
        return false
      }
      if (mode === 'experimental') {
        const state = releasedContext.localDenialTracking ?? releasedContext.getAppState().denialTracking
        if (state?.consecutiveDenials) persistDenialState(releasedContext, recordSuccess(state))
      }
      used = true
      return true
    },
    finishWithoutRelease() {
      if (!used && lastOutcome === 'allowed') stale('The approval expired before the action was released.')
    },
  }
}

export function recordContextualHumanApproval(context: ToolUseContext, toolUseId: string, input: Input): void {
  const attempt = context.contextualAutoAttempt
  if (attempt?.id === toolUseId) attempt.recordHuman(input, context)
}
