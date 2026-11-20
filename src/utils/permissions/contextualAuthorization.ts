import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { feature } from 'bun:bundle'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { recordToolReview } from '../../app-runtime/toolActivity.js'
import { persistAutoModeReview } from '../../app-runtime/autoModeReviewPersistence.js'
import type { AutoModeReview } from '../../app-runtime/autoModeReviewContract.js'
import { scanForSecrets } from '../../services/teamMemorySync/secretScanner.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { getBashExecutionSettings, type BashToolInput } from '../../tools/BashTool/BashTool.js'
import { codeModeToolPrincipal } from '../../tools/REPLTool/codeModeTools.js'
import { getCwd } from '../cwd.js'
import { expandPath } from '../path.js'
import { getSourcedAutoModeInstructions } from '../settings/settings.js'
import { buildContextualReview, contextualReviewerProfile, sendContextualReview } from './contextualReviewer.js'
import { CONTEXTUAL_REVIEW_VERSION } from './contextualReviewPrompt.js'
import { readContextualAuthority, resolveContextualPeerParent } from './contextualAuthority.js'
import { recordAutoModeOutcome } from './autoModeMeta.js'
import { collectPermissionDecisionContexts } from './permissionDecisionContext.js'
import { getConfiguredAutoModeModel } from './yoloClassifier.js'

type Input = Record<string, unknown>
type ReviewMode = 'shadow' | 'experimental'
const readOnlyTools = new Set(['Read', 'Glob', 'Grep', 'LS', 'ListPeers', 'TaskList', 'TaskGet'])

export function mayChangeState(tool: Tool | undefined): boolean {
  return !tool || Boolean(tool.isMcp || tool.mcpInfo) || !readOnlyTools.has(tool.name)
}
const toolEffects: Readonly<Record<string, string>> = {
  Bash: 'Execute the complete shell command in the effective working directory.',
  Edit: 'Replace matching text in the resolved file.',
  Write: 'Create or overwrite the resolved file.',
  Read: 'Read data from the resolved file.',
  REPL: 'Admit the complete submitted source to the isolated Script interpreter. Each child is authorized separately.',
  Agent: 'Launch an agent with the specified assignment and capabilities.',
  CreatePeer: 'Create a new peer and deliver the specified opening assignment.',
  SendToPeer: 'Deliver the specified message to a workspace peer. This can wake that session and start a turn.',
  Announce: 'Replace this session’s scope notice on the workspace peer roster. Peers can read the notice when they list the roster. Posting executes no edits and grants no file permissions.',
}

function projectAction(tool: Tool, input: Input, context: ToolUseContext) {
  const cwd = getCwd()
  const effect = toolEffects[tool.name]
  const parameters = { ...input }
  let execution: Input | undefined
  if (!tool.isMcp && tool.name === 'Bash') {
    // Descriptions describe the agent's intent. Execution flags are engine data.
    const { description: _description, ...bash } = input as BashToolInput
    return { cwd, effect, input: bash, execution: {
      ...getBashExecutionSettings(input as BashToolInput, Boolean(context.inlineCommand), !context.agentId),
      sandboxOverrideRequested: input.dangerouslyDisableSandbox === true,
      workLifetime: input.work_lifetime ?? 'finite',
    } }
  }
  if (!tool.isMcp && ['Read', 'Edit', 'Write'].includes(tool.name) && typeof input.file_path === 'string') {
    const path = expandPath(input.file_path, cwd)
    parameters.file_path = path
    let target = path
    try { target = realpathSync(path) } catch {
      try { target = join(realpathSync(dirname(path)), basename(path)) } catch { /* parent may also be new */ }
    }
    execution = { target, ...(tool.name === 'Write' && { operation: existsSync(path) ? 'overwrite' : 'create' }) }
  }
  if (!tool.isMcp && tool.name === 'REPL') {
    execution = { background: input.run_in_background === true, interpreter: context.agentId ?? 'session' }
  }
  if (tool.isMcp) {
    execution = { server: tool.mcpInfo?.serverName, serverTool: tool.mcpInfo?.toolName }
  }
  return { cwd, input: parameters, effect: tool.isMcp ? undefined : effect, execution }
}

function containsCredentialMaterial(value: string): boolean {
  return /\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{15,}|gh[pousr]_[a-z0-9]{20,}|eyJ[a-z0-9_-]{15,}\.[a-z0-9_-]{10,}|(?:authorization:\s*bearer|(?:access_token|api[_-]?key|password)(?:\\?["'])?\s*[:=])\s*(?:\\?["'])?[^\s"'\\]{8,})|(?:^|[/~])\.(?:ssh|aws|credentials\.json)(?:\/|["'\s]|$)|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
    scanForSecrets(value).length > 0
}

function readMode(): ReviewMode | undefined {
  if (!feature('AUTO_MODE_CONTEXTUAL_REVIEW')) return undefined
  const value = process.env.CLAUDE_CODE_CONTEXTUAL_AUTO_MODE
  const session = process.env.CATCODE_SIDECAR_SESSION_ID
  const selected = process.env.CLAUDE_CODE_CONTEXTUAL_AUTO_MODE_SESSION_ID
  if (value === 'legacy' || (selected && selected !== session)) return undefined
  if (value === 'shadow' || value === 'experimental') return value
  return session ? 'experimental' : undefined
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
  // The engine's typed question receipt authorizes its display and answer.
  // Any action proposed in response still goes through its own permission check.
  if (!tool.isMcp && !tool.mcpInfo && tool.name === ASK_USER_QUESTION_TOOL_NAME) return undefined
  const snapshot = structuredClone(input)
  const action = projectAction(tool, snapshot, context)
  const peerParent = await resolveContextualPeerParent(context,
    tool.name === 'Announce' && !tool.isMcp && !tool.mcpInfo ? context.lookupLegacyPeerCreator : undefined)
  const authority = readContextualAuthority(context, peerParent)
  const policy: ToolPermissionContext = structuredClone(context.getAppState().toolPermissionContext)
  const instructions = getSourcedAutoModeInstructions()
  const principal = codeModeToolPrincipal(tool, context)
  const { cellId, generation } = assistant.codeMode ?? {}
  // Script admission grants the isolated interpreter a single invocation.
  // The calls it submits carry their own delegated mutation gate.
  const delegatedMutation = authority.delegated && mayChangeState(tool) && (tool.isMcp || tool.name !== 'REPL')
  const attemptId = randomUUID()
  const startedAt = Date.now()
  let review: Promise<PermissionDecision> | undefined
  let modelAllowed = false
  let requiresHuman = false
  let humanAllowed = false
  let used = false
  let lastOutcome: AutoModeReview['outcome'] | undefined
  let reviewer: NonNullable<AutoModeReview['reviewer']> = { kind: 'contextual', version: CONTEXTUAL_REVIEW_VERSION }

  function current(candidate: Input, releasedContext: ToolUseContext): boolean {
    const latest = readContextualAuthority(releasedContext, peerParent)
    const liveMcp = tool.isMcp && releasedContext.options.getMcpRuntimeSnapshot?.()
    const principalContext = liveMcp ? { ...releasedContext, options: { ...releasedContext.options, mcpClients: [...liveMcp.clients] } } : releasedContext
    return !latest.pendingOperatorInput && !latest.stopped && isDeepStrictEqual(latest, authority) &&
      isDeepStrictEqual(candidate, snapshot) &&
      isDeepStrictEqual(releasedContext.getAppState().toolPermissionContext, policy) &&
      isDeepStrictEqual(getSourcedAutoModeInstructions(), instructions) &&
      codeModeToolPrincipal(tool, principalContext) === principal &&
      isDeepStrictEqual(projectAction(tool, candidate, releasedContext), action)
  }

  function emit(outcome: AutoModeReview['outcome'], reason?: string) {
    if (mode !== 'experimental') return
    lastOutcome = outcome
    const event: AutoModeReview = { type: 'tool.review', toolUseId, attemptId, startedAt, outcome, reviewer,
      ...(outcome !== 'reviewing' && { completedAt: Math.max(startedAt, Date.now()) }),
      ...(reason && { reason }) }
    persistAutoModeReview(event)
    recordToolReview(event)
  }

  function ask(reason: string, outcome: 'asking' | 'inconclusive' = 'asking'): PermissionDecision {
    requiresHuman = true
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

  async function reviewHeldAction(): Promise<PermissionDecision> {
    if (authority.pendingOperatorInput) return stale('A user message is waiting to be applied.')
    if (!current(input, context)) return stale('The assignment or action changed before review.')
    if (delegatedMutation && !authority.verifiedSource) {
      return ask('This helper has no verified user assignment for the requested action.')
    }
    if (!action.effect) return ask('Auto Mode cannot verify the effects of this tool.')
    const source = context.autoModeInstructionContext ?? undefined
    const evidence = {
      action: { ...action, effect: action.effect, attempt: toolUseId, actor: authority.actor,
        tool: tool.name, ...(cellId && generation && { script: { cellId, generation, source: context.contextualParentScriptSource } }) },
      assignment: authority.assignment,
      conversation: authority.conversation,
      priorDecisions: collectPermissionDecisionContexts(context.messages).slice(-16).map(decision => ({
        action: decision.toolName, outcome: decision.outcome,
      })),
      workspaceInstructions: source,
    }
    const profile = contextualReviewerProfile(getConfiguredAutoModeModel())
    const built = buildContextualReview(evidence, profile, instructions)
    if (!built) return ask('The complete action and applicable instructions exceed the Auto Mode review limit.')
    if (containsCredentialMaterial(JSON.stringify(evidence)) || containsCredentialMaterial(JSON.stringify(instructions))) {
      return ask('The action or its context may contain credentials.')
    }
    reviewer = { ...reviewer, profile: { provider: profile.provider, model: profile.model,
      effort: profile.effort, promptDigest: built.promptDigest } }
    emit('reviewing')
    const result = await sendContextualReview({ ...built.options, agentId: context.agentId }, context.abortController.signal)
    if (result.status === 'valid') reviewer = { ...reviewer, verdict: result.verdict.decision }
    if (!current(input, context)) return stale(context.abortController.signal.aborted
      ? 'The review was cancelled.' : 'The assignment or action changed during review.')
    if (result.status !== 'valid') return ask('Auto Mode could not complete this review.', 'inconclusive')
    const { decision, rationale } = result.verdict
    const reason = containsCredentialMaterial(rationale) ? 'Auto Mode reviewed the proposed action.' : rationale
    if (decision === 'ask') return ask(reason)
    const decisionReason = { type: 'classifier' as const, classifier: 'auto-mode', reason }
    emit(decision === 'allow' ? 'allowed' : 'blocked', reason)
    if (decision === 'deny') {
      if (mode === 'experimental') recordAutoModeOutcome(toolUseId, 'automode-blocked')
      return { behavior: 'deny', message: reason, decisionReason }
    }
    modelAllowed = true
    return { behavior: 'allow', updatedInput: input, decisionReason }
  }

  return {
    id: toolUseId, mode, delegatedMutation, get requiresHuman() { return requiresHuman },
    review: () => review ??= reviewHeldAction(),
    requireHuman(reason: string) { return ask(reason) },
    recordHuman(candidate: Input, replyContext: ToolUseContext) {
      if (requiresHuman && current(candidate, replyContext)) humanAllowed = true
    },
    isCurrent: current,
    release(candidate: Input, releasedContext: ToolUseContext): boolean {
      if (used) return false
      if (!current(candidate, releasedContext) || (requiresHuman ? !humanAllowed : delegatedMutation && !modelAllowed)) {
        stale('The approval no longer matches the current action, assignment or permissions.')
        return false
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
