import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { feature } from 'bun:bundle'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision, PermissionDenyDecision } from '../../types/permissions.js'
import { recordToolReview } from '../../app-runtime/toolActivity.js'
import { persistAutoModeReview } from '../../app-runtime/autoModeReviewPersistence.js'
import type { AutoModeReview } from '../../app-runtime/autoModeReviewContract.js'
import { redactSecrets, scanForSecrets } from '../../services/teamMemorySync/secretScanner.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { isFilePatchToolName, FILE_PATCH_TOOL_NAME } from '../../tools/FilePatchTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import type { getSkillGrantsForReview } from '../../tools/SkillTool/SkillTool.js'
import { getBashExecutionSettings, type BashToolInput } from '../../tools/BashTool/BashTool.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { codeModeToolPrincipal } from '../../tools/REPLTool/codeModeTools.js'
import type { ScriptReviewHistory } from '../../tools/REPLTool/scriptReviewHistory.js'
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
  LSP: 'Read the file and send its full contents to the configured language server if it has not opened the document, then request the specified operation.',
  REPL: 'Admit the complete submitted source to the isolated Script interpreter. The engine checks each child before dispatch.',
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

// Keep surrounding instructions. Leave incomplete private keys for the final
// payload scan, which blocks a request if redaction could not remove them.
function redactRecognizedTokens(text: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(text)) return text
  return redactSecrets(text)
    .replace(/\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{15,}|gh[pousr]_[a-z0-9]{20,}|eyJ[a-z0-9_-]{15,}\.[a-z0-9_-]{10,}(?:\.[a-z0-9_-]+)?)/giu, '[…]')
}

const REVIEW_SECRET = '[…]'
const credentialField = /^(?:access[_-]?token|api[_-]?key|password)$/iu
const credentialAssignment = /(\b(?:authorization:\s*bearer\s+|(?:access[_-]?token|api[_-]?key|password)["']?\s*[:=]\s*["']?))[^\s"'\\]{8,}/giu

function redactReviewText(text: string): string {
  const withoutKeys = text.replace(
    /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/giu,
    REVIEW_SECRET,
  )
  return redactRecognizedTokens(withoutKeys).replace(credentialAssignment, '$1' + REVIEW_SECRET)
    .replaceAll('[REDACTED]', REVIEW_SECRET)
}

function redactReviewFields<T>(value: T): T {
  if (typeof value === 'string') return redactReviewText(value) as T
  if (Array.isArray(value)) return value.map(row => redactReviewFields(row)) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [
      key, typeof field === 'string' && field.length >= 8 && credentialField.test(key)
        ? REVIEW_SECRET : typeof field === 'string' && key.toLowerCase() === 'authorization'
          ? field.replace(/^(\S+\s+).+$/u, '$1' + REVIEW_SECRET)
          : redactReviewFields(field),
    ])) as T
  }
  return value
}

export function contextualAutoReviewMode(): ReviewMode | undefined {
  if (!feature('AUTO_MODE_CONTEXTUAL_REVIEW')) return undefined
  const value = process.env.CLAUDE_CODE_CONTEXTUAL_AUTO_MODE
  const session = process.env.CATCODE_SIDECAR_SESSION_ID
  const selected = process.env.CLAUDE_CODE_CONTEXTUAL_AUTO_MODE_SESSION_ID
  if (value === 'legacy' || (selected && selected !== session)) return undefined
  if (value === 'shadow' || value === 'experimental') return value
  return 'experimental'
}

/**
 * One per Script cell. The first whole-Script allowance binds all later
 * children to the same authority, policy and instructions.
 */
export type ContextualScriptGrant = {
  readonly cellId: string
  readonly generation: string
  readonly history: ScriptReviewHistory
  releaseRefusal?: string
  releaseExpiry?: { toolUseId: string; reason: string }
  granted?: {
    isCurrent(context: ToolUseContext): boolean
  }
}

function withoutDefaultRules(instructions: ReturnType<typeof getSourcedAutoModeInstructions>) {
  return instructions.flatMap(({ source, ...sections }) => {
    const custom = Object.fromEntries(Object.entries(sections).flatMap(([section, entries]) => {
      const rules = entries?.filter(rule => rule.trim() !== '$defaults')
      return rules?.length ? [[section, rules]] : []
    }))
    return Object.keys(custom).length ? [{ source, ...custom }] : []
  })
}

export type ContextualAutoAttempt = NonNullable<Awaited<ReturnType<typeof createContextualAttempt>>>

export async function createContextualAttempt(
  tool: Tool,
  input: Input,
  context: ToolUseContext,
  assistant: AssistantMessage,
  toolUseId: string,
) {
  const mode = contextualAutoReviewMode()
  if (!mode || (mode === 'shadow' && assistant.codeMode)) return undefined
  const mcp = isMcpTool(tool)
  // The engine's typed question receipt authorizes its display and answer.
  // Any action proposed in response still goes through its own permission check.
  if (!mcp && tool.name === ASK_USER_QUESTION_TOOL_NAME) return undefined
  const snapshot = structuredClone(input)
  const action = projectAction(tool, snapshot, context)
  const peerParent = await resolveContextualPeerParent(context, context.lookupLegacyPeerCreator)
  let authority = readContextualAuthority(context, peerParent)
  const policy: ToolPermissionContext = structuredClone(context.getAppState().toolPermissionContext)
  const instructions = getSourcedAutoModeInstructions()
  const principal = codeModeToolPrincipal(tool, context)
  const { cellId, generation } = assistant.codeMode ?? {}
  const holder = context.contextualScriptGrant
  const scriptChild = Boolean(assistant.codeMode)
  const scriptGrant = holder && holder.cellId === cellId && holder.generation === generation ? holder : undefined
  const scriptWrapper = !mcp && tool.name === REPL_TOOL_NAME
  let allowedOutsideRead = false
  function isReviewException(): boolean {
    if (mcp) return tool.contextualClosedWorldRead === true
    return tool.name === 'REPL' || tool.name === 'LSP' ||
      tool.name === 'BrowserAct' || tool.name === 'BrowserNavigate' ||
      (tool.name === 'Bash' && allowedOutsideRead)
  }

  function delegatedStateChange(): boolean {
    return authority.delegated && mayChangeState(tool, snapshot) &&
      (mcp || tool.name !== 'REPL') && !isReviewException()
  }

  function needsDelegatedScopeReview(): boolean {
    if (!delegatedStateChange()) return false
    const { parent, parentAnchor } = authority.assignment ?? {}
    const anchor = parent?.findIndex(row => row.id === parentAnchor) ?? -1
    if (anchor >= 0 && parent?.some((row, index) => index > anchor && row.origin === 'operator')) return true
    // A peer can see the operator's messages in its own conversation.
    return Boolean(context.agentId && authority.conversation.filter(row => row.origin === 'operator').length > 1)
  }
  const latestOperator = authority.conversation.findLast(row => row.origin === 'operator' && row.id)
  const newOperatorTurn = latestOperator && !context.messages.some(row => row.uuid === latestOperator.id)
  const followUps = [...authority.pendingConversation, ...(newOperatorTurn && latestOperator ? [latestOperator] : [])]
  // An additive request for the result or a workspace change can drain after
  // an already-approved read. Review other follow-ups for scoped withdrawals.
  const mayAffectRead = followUps.some(({ text }) => {
    const instruction = text.trim()
    const summary = /^(?:please\s+)?(also\s+)?(?:summarize(?:\s+the\s+(?:work|results|findings))?|(?:give (?:me|us)|include|provide)\s+(?:a\s+)?(?:(?:short|brief)\s+)?summary)(\s+(?:afterwards?|when (?:you(?:'re| are)|it(?:'s| is)) done|after the (?:checks|read|work)))?[.!?]?$/iu.exec(instruction)
    if (summary?.[1] || summary?.[2]) return false
    return !/^(?:oh,\s+)?(?:please\s+)?(?:work in|switch to|use)\s+(?:the\s+)?[a-z0-9][a-z0-9_-]*\s+workspace(?:\.\s+use (?:the\s+)?peer ses+ion feature)?[.!?]?$/iu.test(instruction)
  })
  let reviewedInstructions = false
  let attemptId = randomUUID()
  let startedAt = Date.now()
  let review: Promise<PermissionDecision> | undefined
  let reviewStarted = false
  let wholeScriptAttempt = false
  let actionAllowed = false
  let requiresHuman = false
  let humanAllowed = false
  let coveringGrant: ContextualScriptGrant | undefined
  let used = false
  let lastOutcome: AutoModeReview['outcome'] | undefined
  let reviewFailure: 'unavailable' | 'invalid_response' | 'context_limit' | 'review_expired' | 'interrupted' | undefined
  let reviewer: NonNullable<AutoModeReview['reviewer']> = { kind: 'contextual', version: CONTEXTUAL_REVIEW_VERSION }
  let boundProjection: { value: unknown } | undefined
  let reviewedSkillGrants: { value: Awaited<ReturnType<typeof getSkillGrantsForReview>> } | undefined

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
    if (scriptGrant?.granted) return !scriptGrant.granted.isCurrent(context)
    // A busy prompt drains at the end of the tool round. Reads already allowed
    // under this snapshot may finish it; later authority changes still fence release.
    return (!reviewedInstructions && (mayAffectRead || mayChangeState(tool, snapshot) && followUps.length > 0)) ||
      !isDeepStrictEqual(readContextualAuthority(context, peerParent), authority)
  }

  function emit(outcome: AutoModeReview['outcome'], reason?: string) {
    lastOutcome = outcome
    if (mode !== 'experimental') return
    const event: AutoModeReview = { type: 'tool.review', toolUseId, attemptId, startedAt, outcome,
      reviewer,
      ...(outcome !== 'reviewing' && { completedAt: Math.max(startedAt, Date.now()) }),
      ...(reason && { reason }) }
    persistAutoModeReview(event)
    recordToolReview(event)
  }

  function routineNoticeDecision(): PermissionDecision | undefined {
    if (mcp || tool.name !== 'Announce' ||
        authority.stopped || authority.pendingOperatorInput) return undefined
    const operatorRows = [...(authority.assignment?.parent ?? []), ...authority.conversation].filter(row => row.origin === 'operator')
    const operatorText = operatorRows.flatMap(row => row.proposal ? [row.proposal.text, row.text] : [row.text])
    const settings = instructions.flatMap(row =>
      [...(row.allow ?? []), ...(row.soft_deny ?? []), ...(row.hard_deny ?? []), ...(row.environment ?? [])])
    const privacyVeto = /(?:^|[.!?]\s+)(?:keep (?:this|this (?:task|work|investigation)) private|(?:do not|don't) (?:announce (?:this|this task)|post (?:a |the )?scope notice))[.!]?$/iu
    if (privacyVeto.test(operatorRows.at(-1)?.text ?? '')) {
      const reason = 'You asked to keep this work off the workspace roster.'
      return { behavior: 'deny', message: reason, decisionReason: { type: 'other', reason } }
    }
    const workspace = workspaceInstructionsForReview(context.autoModeInstructionContext) ?? ''
    // Workspace guides also discuss UI visibility and paths such as app/shared.
    const audienceLimit = /\b(?:discree\w*|privacy|(?:task|work|session) visibility|visibility (?:is |stays )?(?:limited|restricted)|embargo\w*|under wraps|in confidence|(?:your|our|my) eyes only|to yourself|between (?:the )?(?:two of us|you and me|us)|(?:this|our|the current) (?:chat|conversation|session) only|(?:inside|within|outside|beyond|limited to|leave|leaves) (?:of )?(?:this|our|the current) (?:chat|conversation|session))\b/iu
    const standingNoticeRule = /\b(?:under wraps|in confidence|(?:this|our|the current) (?:chat|conversation|session) only|(?:inside|within|outside|beyond|limited to) (?:of )?(?:this|our|the current) (?:chat|conversation|session)|visibility (?:is |stays )?(?:limited|restricted))\b|(?:do not|don't|never|must not|avoid|ask before)[^.!?\n]{0,100}\b(?:announc\w*|roster|scope notices?)\b|\b(?:announc\w*|roster|scope notices?)\b[^.!?\n]{0,80}\b(?:forbidden|prohibited|requires? approval|private)\b/iu
    // Keep the earlier veto in review so newer instructions can be weighed against it.
    if (operatorRows.some(row => privacyVeto.test(row.text)) ||
        [...operatorText, authority.assignment?.text ?? '', ...settings].some(text => audienceLimit.test(text)) ||
        standingNoticeRule.test(workspace)) return undefined
    actionAllowed = true
    return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'mode', mode: 'auto' } }
  }

  function ask(reason: string): PermissionDecision {
    requiresHuman = true
    humanAllowed = false
    emit('asking', reason)
    if (mode === 'experimental') recordAutoModeOutcome(toolUseId, 'unanswered')
    if (policy.shouldAvoidPermissionPrompts) return {
      behavior: 'deny', message: reason + ' Interactive approval is unavailable.',
      decisionReason: { type: 'asyncAgent', reason },
    }
    return { behavior: 'ask', humanOnly: true, message: reason, updatedInput: input,
      decisionReason: { type: 'classifier', classifier: 'auto-mode', reason } }
  }

  function denyReview(reason: string, outcome: 'blocked' | 'inconclusive' = 'blocked'): PermissionDecision {
    emit(outcome, reason)
    if (mode === 'experimental') {
      recordAutoModeOutcome(toolUseId, outcome === 'inconclusive' ? 'automode-unavailable' : 'automode-blocked')
    }
    return { behavior: 'deny', message: reason, decisionReason: { type: 'classifier', classifier: 'auto-mode', reason } }
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
    reviewFailure = undefined
    actionAllowed = false
  }

  function coveredByScript(): PermissionDecision | undefined {
    const granted = scriptGrant?.granted
    if (!granted) return undefined
    if (!granted.isCurrent(context)) return scriptStale()
    reviewStarted = true
    reviewedInstructions = true
    const reason = 'Covered by the Auto Mode review of this script.'
    actionAllowed = true
    return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'classifier', classifier: 'auto-mode', reason } }
  }

  function scriptStale(waitingForUser = false): PermissionDenyDecision {
    const cancelled = context.abortController.signal.aborted
    reviewFailure = cancelled ? 'interrupted' : 'review_expired'
    const verdict = reviewer.verdict ? {
      allow: 'The reviewer allowed this action. ',
      deny: 'The reviewer denied this action. ',
      ask: 'The reviewer requested your approval. ',
    }[reviewer.verdict] : ''
    const reason = verdict + (cancelled
      ? 'The Script review was cancelled before the action ran.'
      : waitingForUser
        ? 'A user message is waiting. Author a new Script after its instructions are applied.'
        : 'The engine held the action before it ran because its review was no longer current. Author a new Script using the current instructions and permissions.')
    emit('inconclusive', reason)
    return { behavior: 'deny', message: reason,
      decisionReason: { type: 'other', reason, scriptReviewExpired: true } }
  }

  function scriptSizeLimit(reason: string): PermissionDecision {
    reviewFailure = 'context_limit'
    return denyReview(reason, 'inconclusive')
  }

  async function reviewHeldAction(canRefresh = true): Promise<PermissionDecision> {
    reviewStarted = true
    coveringGrant = undefined
    if (scriptChild && !scriptGrant) {
      return denyReview('Auto Mode could not establish review authority for this Script. Submit a new Script cell.', 'inconclusive')
    }
    wholeScriptAttempt = Boolean(scriptGrant)
    if (scriptGrant?.history.unavailableReason) {
      return scriptSizeLimit(`${scriptGrant.history.unavailableReason} The request could not reach the reviewer. The held action did not run. Resume the chat to reset the Script interpreter before continuing.`)
    }
    if (authority.pendingOperatorInput) return scriptChild
      ? scriptStale(true)
      : stale('A user message is waiting to be applied.')
    if (!refreshInstructions()) return scriptChild ? scriptStale() : stale('The assignment or action changed before review.')
    reviewedInstructions = true
    let toolDescription: string | undefined
    if (!action.effect) {
      try {
        toolDescription = (await tool.description(input, {
          isNonInteractiveSession: context.options.isNonInteractiveSession,
          toolPermissionContext: policy,
          tools: context.options.tools,
        })).trim()
      } catch { /* The reviewer still receives the tool principal and complete arguments. */ }
      if (!refreshInstructions()) return scriptChild ? scriptStale() : stale('The assignment or action changed before review.')
    }
    const effect = action.effect ?? 'Invoke the named tool with the supplied arguments.'
    if (!mcp && tool.name === SKILL_TOOL_NAME && typeof snapshot.skill === 'string') {
      const { getSkillGrantsForReview } = await import('../../tools/SkillTool/SkillTool.js')
      reviewedSkillGrants = { value: structuredClone(await getSkillGrantsForReview(snapshot.skill, context)) }
      if (!refreshInstructions()) return scriptChild ? scriptStale() : stale('The assignment or action changed before review.')
    }
    const resolvedAction = currentProjection()
    if (resolvedAction !== undefined) boundProjection = { value: structuredClone(resolvedAction) }
    const source = workspaceInstructionsForReview(context.autoModeInstructionContext)
    const path = !mcp && tool.name === 'Write' && typeof input.file_path === 'string'
      ? expandPath(input.file_path, action.cwd) : undefined
    const previous = path && context.readFileState.get(path)
    const proposedChanges = path && previous && isCompleteUnboundedRead(previous) && typeof input.content === 'string'
      ? getPatchFromContents({ filePath: path, oldContent: previous.content, newContent: input.content }).flatMap(hunk => hunk.lines)
      : undefined
    const conversation = [...authority.conversation, ...authority.pendingConversation]
    const runs = recentShellRuns(context.getCurrentAutoModeMessages?.() ?? context.messages, conversation, context.contextualWorkerAssignment?.excluded)
    const rawEvidence: ContextualEvidence = {
      ...(toolDescription && { toolDescription }),
      ...(!mcp && tool.name === 'Bash' && typeof input.description === 'string' && { agentStatedPurpose: input.description }),
      ...(runs.length && { recentShellRuns: runs }),
      action: { ...action, effect, attempt: toolUseId, actor: authority.actor,
        execution: { ...action.execution,
          ...(reviewedSkillGrants?.value && { skillGrants: reviewedSkillGrants.value }),
          ...(proposedChanges?.length && { proposedChangesFromLastCompleteRead: {
            addedLines: proposedChanges.filter(line => line.startsWith('+')).length,
            removedLines: proposedChanges.filter(line => line.startsWith('-')).length,
          } }),
          ...(boundProjection && { resolvedAction: boundProjection.value }) },
        tool: tool.name, ...(scriptGrant && { script: {
          cellId: scriptGrant.cellId, generation: scriptGrant.generation,
          ...scriptGrant.history.reviewEvidence(),
        } }) },
      assignment: authority.assignment,
      conversation,
      priorDecisions: collectPermissionDecisionContexts(context.messages).slice(-16).map(decision => ({
        action: decision.toolName, outcome: decision.outcome,
      })),
      workspaceInstructions: source,
    }
    const evidence = redactReviewFields(rawEvidence)
    const reviewerInstructions = redactReviewFields(withoutDefaultRules(instructions))
    const profile = contextualReviewerProfile(getConfiguredAutoModeModel())
    const built = buildContextualReview(evidence, profile, reviewerInstructions, scriptChild)
    if (!built) {
      if (scriptGrant) {
        return scriptSizeLimit('The Script review request exceeded its size limit before reaching the reviewer. The held action did not run. Report this blocker in chat.')
      }
      if (!buildContextualReview({ action: evidence.action, conversation: [] }, profile)) {
        return denyReview('This action exceeds the Auto Mode review limit. Split this action into smaller calls and retry.')
      }
      return denyReview('The applicable instructions and action exceed the Auto Mode review limit. Report this blocker in chat.')
    }
    if (containsCredentialMaterial(JSON.stringify(evidence)) ||
        containsCredentialMaterial(JSON.stringify(reviewerInstructions))) {
      return denyReview('Auto Mode could not safely redact credentials from this action. Revise the action or report the blocker in chat.')
    }
    reviewer = { kind: 'contextual', version: CONTEXTUAL_REVIEW_VERSION, profile: { provider: profile.provider, model: profile.model,
      effort: profile.effort, promptDigest: built.promptDigest } }
    emit('reviewing')
    const result = await sendContextualReview({ ...built.options, agentId: context.agentId }, context.abortController.signal)
    if (result.status === 'valid') reviewer = { ...reviewer, verdict: result.verdict.decision }
    if (!current(input, context)) {
      if (scriptChild) return scriptStale()
      if (canRefresh && refreshInstructions()) {
        renewReview()
        return reviewHeldAction(false)
      }
      return stale(context.abortController.signal.aborted
        ? 'The review was cancelled.' : 'The assignment or action changed during review.')
    }
    if (result.status !== 'valid') {
      if (result.status !== 'cancelled') {
        reviewFailure = result.status === 'invalid' ? 'invalid_response' : 'unavailable'
      }
      return denyReview(scriptChild
        ? 'Auto Mode could not complete the Script review. Submit a new Script cell when the reviewer is available.'
        : 'Auto Mode could not complete this review. Retry or report the blocker in chat.', 'inconclusive')
    }
    const { decision, rationale } = result.verdict
    const reason = containsCredentialMaterial(rationale) ? 'Auto Mode reviewed the proposed action.' : rationale
    if (decision === 'ask') {
      coveringGrant = scriptGrant
      return ask(coveringGrant ? `${reason} Yes covers the rest of this Script without another model review. Tool permissions and required confirmations still apply.` : reason)
    }
    const decisionReason = { type: 'classifier' as const, classifier: 'auto-mode', reason }
    if (decision === 'deny') {
      const state = recordDenial(context.localDenialTracking ?? context.getAppState().denialTracking ?? createDenialTrackingState())
      if (mode === 'experimental') persistDenialState(context, state)
      if (state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive) {
        return denyReview(`${state.consecutiveDenials} consecutive actions were denied. Stop and report the blocker in chat. Latest reason: ${reason}`)
      }
      return denyReview(reason)
    }
    emit('allowed', reason)
    actionAllowed = true
    coveringGrant = scriptGrant
    return { behavior: 'allow', updatedInput: input, decisionReason }
  }

  return {
    id: toolUseId, mode, routineNoticeDecision,
    get isReviewException() { return isReviewException() },
    get delegated() { return authority.delegated },
    get mayChangeState() { return mayChangeState(tool, snapshot) },
    get delegatedStateChange() { return delegatedStateChange() },
    needsDelegatedScopeReview,
    recordAllowedOutsideRead() { allowedOutsideRead = true },
    get requiresHuman() { return requiresHuman },
    get reviewFailure() { return reviewFailure },
    get reviewedSkillGrants() { return reviewedSkillGrants },
    review: () => review ??= Promise.resolve(coveredByScript() ?? reviewHeldAction()),
    needsInstructionReview,
    async reviewFollowUp() {
      if ((scriptChild && (reviewStarted || requiresHuman || scriptGrant?.granted)) || (scriptWrapper && mode === 'experimental')) return scriptStale()
      renewReview()
      return reviewHeldAction()
    },
    requireHuman(reason: string) {
      coveringGrant = undefined
      return ask(reason)
    },
    recordHuman(candidate: Input, replyContext: ToolUseContext) {
      if (!requiresHuman || !unchangedAction(candidate, replyContext)) return
      humanAllowed = true
    },
    isCurrent: current,
    release(candidate: Input, releasedContext: ToolUseContext): boolean {
      if (used) return false
      if (scriptGrant?.granted && containsCredentialMaterial(JSON.stringify(redactReviewFields({
        action: projectAction(tool, candidate, releasedContext),
        resolvedAction: currentProjection(),
      })))) {
        const reason = 'Auto Mode could not safely redact credentials from this Script action. Revise the Script to avoid passing credential material.'
        scriptGrant.releaseRefusal = reason
        denyReview(reason)
        throw new Error(reason)
      }
      const matches = (!scriptGrant?.granted || scriptGrant.granted.isCurrent(releasedContext)) && current(candidate, releasedContext)
      if (!matches || (requiresHuman ? !humanAllowed : reviewStarted && !actionAllowed)) {
        const reason = 'The approval no longer matches the current action, assignment or permissions.'
        if (scriptGrant && !matches) {
          scriptGrant.releaseExpiry = { toolUseId, reason: scriptStale().message }
        } else {
          if (scriptGrant) scriptGrant.releaseRefusal = 'The Script approval could not be verified before the action ran.'
          stale(scriptGrant?.releaseRefusal ?? reason)
        }
        return false
      }
      if (coveringGrant) {
        const approvedAuthority = structuredClone(authority)
        coveringGrant.granted = {
          isCurrent: liveContext => {
            const latest = readContextualAuthority(liveContext, peerParent)
            return contextualAutoReviewMode() === 'experimental' &&
              !latest.stopped && !latest.pendingOperatorInput && isDeepStrictEqual(latest, approvedAuthority) &&
              isDeepStrictEqual(liveContext.getAppState().toolPermissionContext, policy) &&
              isDeepStrictEqual(getSourcedAutoModeInstructions(), instructions)
          },
        }
      }
      if (mode === 'experimental' && (mcp || tool.name !== 'REPL')) {
        const state = releasedContext.localDenialTracking ?? releasedContext.getAppState().denialTracking
        if (state?.consecutiveDenials) persistDenialState(releasedContext, recordSuccess(state))
      }
      used = true
      return true
    },
    finishWithoutRelease() {
      if (used) return
      if (wholeScriptAttempt && scriptGrant && !scriptGrant.releaseExpiry) {
        scriptGrant.releaseRefusal ??= 'This Script did not receive a covering approval. Author a new Script after resolving the refusal.'
      }
      if (lastOutcome === 'allowed') {
        if (scriptChild) emit('inconclusive', 'The reviewer allowed this action. The action did not run.')
        else stale('The approval expired before the action was released.')
      }
    },
  }
}

export function recordContextualHumanApproval(context: ToolUseContext, toolUseId: string, input: Input): void {
  const attempt = context.contextualAutoAttempt
  if (attempt?.id === toolUseId) attempt.recordHuman(input, context)
}
