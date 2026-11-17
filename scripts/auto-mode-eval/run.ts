#!/usr/bin/env bun
import { feature } from 'bun:bundle'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Message } from '../../src/types/message.js'
import type { PermissionDecisionContext } from '../../src/utils/permissions/permissionDecisionContext.js'
import type { YoloClassifierStageObserver } from '../../src/utils/permissions/yoloClassifier.js'
import { EVIDENCE_CASES, type EvidenceCase } from './cases.js'
import { compareSamples, type StageDiagnostic, type VerdictSample } from './grade.js'
import { prepareResume, sampleKey, verifyRetainedRequest, type EvidenceRecord } from './resume.js'
import { comparePayloadEvidence, inspectPayloadEvidence } from './payloadEvidence.js'

type Variant = VerdictSample['variant']
type Args = { live: boolean; model?: string; account?: string; accountIdPrefix?: string; maxRequests?: number; resume?: string; verifyResume?: boolean; only?: string; out?: string; repeats: number }

function parseArgs(argv: string[]): Args {
  const args: Args = { live: false, repeats: 1 }
  let mode = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--verify-resume') { args.verifyResume = true; continue }
    if (arg === '--live' || arg === '--offline') {
      if (mode) throw new Error('Choose exactly one of --offline or --live')
      mode = true; args.live = arg === '--live'; continue
    }
    if (!['--model', '--account', '--account-id-prefix', '--max-requests', '--resume', '--only', '--out', '--repeats'].includes(arg ?? '')) throw new Error(`Unknown argument: ${arg}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--model') args.model = value
    if (arg === '--account') args.account = value
    if (arg === '--account-id-prefix') args.accountIdPrefix = value
    if (arg === '--max-requests') args.maxRequests = Number(value)
    if (arg === '--resume') args.resume = resolve(value)
    if (arg === '--only') args.only = value
    if (arg === '--out') args.out = resolve(value)
    if (arg === '--repeats') args.repeats = Number(value)
  }
  if (!mode) throw new Error('Choose --offline (no network) or --live (authorized quota use)')
  if (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > 10) throw new Error('--repeats must be 1 through 10')
  if (args.live && (!args.model || !args.account)) throw new Error('--live requires --model and --account selecting an observed account')
  if (args.live && (!args.accountIdPrefix || !Number.isInteger(args.maxRequests) || args.maxRequests! < 1)) throw new Error('--live requires --account-id-prefix and a positive --max-requests authorized limit')
  if (args.resume && !args.live) throw new Error('--resume requires --live; validation uses the same trusted settings as the original evaluation')
  if (args.verifyResume && !args.resume) throw new Error('--verify-resume requires --resume')
  return args
}

/** Canonical synthetic snapshots. Delivery correctness belongs to app-runtime tests. */
async function buildMessages(testCase: EvidenceCase): Promise<Message[]> {
  const { capturePriorAssistantContext } = await import('../../src/utils/permissions/priorAssistantContext.js')
  let messages: Message[] = []
  const decisions: PermissionDecisionContext[] = []
  let sequence = 0
  for (const turn of testCase.turns) {
    const uuid = `${testCase.id}-${++sequence}`
    switch (turn.kind) {
      case 'user': {
        const binding = turn.bindProposal ? capturePriorAssistantContext(messages) : null
        messages.push((turn.queued
          ? { type: 'attachment', uuid, attachment: { type: 'queued_command', prompt: turn.text, commandMode: 'prompt', origin: turn.origin, priorAssistantContext: binding } }
          : { type: 'user', uuid, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: turn.text }, origin: turn.origin, priorAssistantContext: binding }) as Message)
        break
      }
      case 'proposal':
        messages.push({ type: 'assistant', uuid, message: { role: 'assistant', model: 'synthetic-eval-model', content: [{ type: 'text', text: turn.text }] } } as Message)
        break
      case 'call': {
        const toolUseId = `call-${uuid}`
        messages.push({ type: 'assistant', uuid, message: { role: 'assistant', model: 'synthetic-eval-model', content: [{ type: 'tool_use', id: toolUseId, name: turn.tool, input: turn.input }] } } as Message)
        const decision: PermissionDecisionContext | undefined = turn.refused ? {
          version: 1, toolUseId, assistantUuid: uuid, toolName: turn.tool, input: turn.input, outcome: 'rejected-by-user',
        } : undefined
        if (decision) decisions.push(decision)
        messages.push({ type: 'user', uuid: `result-${uuid}`, sourceToolAssistantUUID: uuid,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: turn.result ?? 'Synthetic result', ...(turn.refused && { is_error: true }) }] },
          ...(decision && { permissionDecision: decision }),
        } as Message)
        break
      }
      case 'compact':
        messages = [{ type: 'system', subtype: 'compact_boundary', uuid: `boundary-${uuid}`, permissionDecisions: [...decisions] } as Message,
          { type: 'user', uuid, isCompactSummary: true, ...(turn.relayed && { summarizedRelayedInput: true }), message: { role: 'user', content: turn.text } } as Message]
        break
      case 'nested':
        messages.push({ type: 'attachment', uuid, attachment: { type: 'nested_memory', path: turn.path, displayPath: turn.path,
          content: { path: turn.path, type: 'Project', content: turn.text } } } as Message)
        break
    }
  }
  return messages
}

function requestDigest(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function boundedReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').slice(0, 600)
}

const args = parseArgs(process.argv.slice(2))
if (!feature('TRANSCRIPT_CLASSIFIER') || !feature('AUTO_MODE_UPSTREAM_PORT')) {
  throw new Error('Enable both --feature=TRANSCRIPT_CLASSIFIER and --feature=AUTO_MODE_UPSTREAM_PORT')
}
const cases = args.only ? EVIDENCE_CASES.filter(c => c.id === args.only) : [...EVIDENCE_CASES]
if (!cases.length) throw new Error(`No case matches ${args.only}`)

// Offline execution cannot reach user configuration, credentials, or the real transport.
const offlineHome = args.live ? undefined : await mkdtemp(join(tmpdir(), 'auto-mode-eval-'))
const previousCwd = process.cwd()
let restoreTransportFetch: (() => void) | undefined
if (offlineHome) {
  process.env.CLAUDE_CONFIG_DIR = offlineHome
  process.env.CLAUDE_CODE_AUTO_MODE_MODEL = args.model ?? 'gpt-6-luna'
  process.chdir(offlineHome)
} else {
  process.env.CLAUDE_CODE_AUTO_MODE_MODEL = args.model!
}

try {
  const [{ _forTest, formatActionForClassifier, YOLO_CLASSIFIER_TOOL_NAME }, { setCachedClaudeMdContent }, { enableConfigs }, { BashTool }, { FileWriteTool }, { FileReadTool }, { FileEditTool }] = await Promise.all([
    import('../../src/utils/permissions/yoloClassifier.js'), import('../../src/bootstrap/state.js'),
    import('../../src/utils/config.js'), import('../../src/tools/BashTool/BashTool.js'), import('../../src/tools/FileWriteTool/FileWriteTool.js'),
    import('../../src/tools/FileReadTool/FileReadTool.js'), import('../../src/tools/FileEditTool/FileEditTool.js'),
  ])
  enableConfigs()
  const transportModule = args.live ? await import('./transport.js') : undefined
  const account = transportModule ? await transportModule.observedAccount(args.account!) : undefined
  if (account && !account.accountId.startsWith(args.accountIdPrefix!)) throw new Error('Selected account does not match the authorized account identity')
  const accountIdentity = account ? { reference: createHash('sha256').update(account.accountId).digest('hex').slice(0, 12),
    alias: account.alias ?? null, idPrefix: account.accountId.slice(0, 8) } : null
  const tools = [BashTool, FileWriteTool, FileReadTool, FileEditTool]
  const permissionContext = { mode: 'auto' as const, additionalWorkingDirectories: new Map<string, { path: string; source: 'session' }>(),
    alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false }
  const corpusDigest = createHash('sha256').update(JSON.stringify(cases)).digest('hex')
  const resumed = args.resume ? prepareResume(await Bun.file(args.resume).json(), { cases, repeats: args.repeats,
    model: args.model!, account: accountIdentity!, maxRequests: args.maxRequests!, corpusDigest }) : undefined
  // Before any send, rebuild the retained requests with canned responses and
  // compare their hashes. Settings, instructions and policy must still match.
  for (const record of resumed?.retained.values() ?? []) {
    const testCase = cases.find(c => c.id === record.sample.id)!
    setCachedClaudeMdContent(testCase.instructions ?? null)
    const digests: string[] = []
    const validatedRequests: unknown[] = []
    await _forTest.classifyYoloAction(await buildMessages(testCase), formatActionForClassifier(testCase.action.tool, testCase.action.input),
      tools, permissionContext, new AbortController().signal, { priorAssistantContext: true, inputVariant: record.sample.variant,
        sideQuery: async options => {
          const request = { model: options.model, system: options.system, messages: options.messages, tools: options.tools }
          validatedRequests.push(request)
          digests.push(requestDigest(request))
          return { id: 'resume-validation', type: 'message', role: 'assistant', model: options.model,
            content: [{ type: 'tool_use', id: 'resume-verdict', name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: digests.length === 1 } }],
            stop_reason: 'tool_use', stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          } as Awaited<ReturnType<typeof import('../../src/utils/sideQuery.js').sideQuery>>
        } })
    verifyRetainedRequest(record, digests)
    // Counts and evidence checks are derived diagnostics, not trusted results
    // from the report. Recompute them from the hash-validated request prefix.
    const verifiedEvidence = inspectPayloadEvidence(testCase, record.sample.variant, validatedRequests.slice(0, record.evidence.stages))
    if (verifiedEvidence.missing.length || verifiedEvidence.unexpected.length) throw new Error(`Resume evidence contract changed for ${sampleKey(record.sample)}`)
    Object.assign(record.evidence, verifiedEvidence)
  }
  if (args.verifyResume) {
    console.log(JSON.stringify({ resumeVerified: true, retained: resumed!.retained.size, pending: resumed!.pending,
      priorBackendSends: resumed!.priorBackendSends, remainingRequests: resumed!.remainingRequests,
      addedCaseIds: resumed!.addedCaseIds, backendSends: 0 }, null, 2))
    process.exit(0)
  }
  const remainingRequests = resumed?.remainingRequests ?? args.maxRequests
  const pinned = transportModule && remainingRequests! > 0 ? transportModule.pinnedCodexTransport(account!, args.model!, remainingRequests!) : undefined
  restoreTransportFetch = pinned?.restoreFetch
  const samples: VerdictSample[] = [...(resumed?.retained.values() ?? [])].map(r => r.sample)
  const evidenceReports: EvidenceRecord[] = [...(resumed?.retained.values() ?? [])].map(r => r.evidence)
  let stoppedEarly: string | null = null
  evaluation: for (let repeat = 0; repeat < args.repeats; repeat++) for (const testCase of cases) {
    // Alternate order to reduce systematic warm-cache bias in the paired comparison.
    const variants: Variant[] = repeat % 2 ? ['reduced', 'full'] : ['full', 'reduced']
    for (const variant of variants) {
      if (resumed?.retained.has(sampleKey({ id: testCase.id, repeat, variant }))) continue
      setCachedClaudeMdContent(testCase.instructions ?? null)
      const messages = await buildMessages(testCase)
      const captured: unknown[] = []
      const requestedModels: string[] = []
      let activeStage: StageDiagnostic['stage'] = 'fast'
      const stageReasons = new Map<StageDiagnostic['stage'], string>()
      const stageDecisions: StageDiagnostic[] = []
      const observation: YoloClassifierStageObserver = {
        enterStage(stage) { activeStage = stage },
        resolveStage(stage, resolution) {
          if ('should_block' in resolution) {
            const reason = stageReasons.get(stage)
            stageDecisions.push({ stage, shouldBlock: resolution.should_block, ...(reason !== undefined && { reason }) })
          } else stageDecisions.push({ stage, failure: resolution.failure })
        },
      }
      const transport: typeof import('../../src/utils/sideQuery.js').sideQuery = async options => {
        captured.push({ model: options.model, system: options.system, messages: options.messages, tools: options.tools })
        requestedModels.push(options.model)
        if (args.live) {
          if (options.model !== args.model) throw new Error('Model fallback is outside this evaluation authorization')
          if (!pinned) throw new Error('No authorized reviewer sends remain')
          const response = await pinned.send(options)
          // Capture only the explicit public verdict reason. The observer below
          // supplies validated decisions; raw model thinking is never reported.
          if (activeStage === 'thinking') {
            const verdict = response.content.find(block => block.type === 'tool_use' && block.name === YOLO_CLASSIFIER_TOOL_NAME)
            const input = verdict?.type === 'tool_use' ? verdict.input : undefined
            const reason = boundedReason(input && typeof input === 'object' && 'reason' in input ? input.reason : undefined)
            if (reason !== undefined) stageReasons.set(activeStage, reason)
          }
          return response
        }
        // Exercise both request builders. These canned verdicts are never graded.
        return { id: `offline-${captured.length}`, type: 'message', role: 'assistant', model: options.model,
          content: [{ type: 'tool_use', id: 'offline-verdict', name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: captured.length === 1 } }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as Awaited<ReturnType<typeof transport>>
      }
      const start = performance.now()
      try {
        const result = await _forTest.classifyYoloAction(messages,
          formatActionForClassifier(testCase.action.tool, testCase.action.input), tools, permissionContext,
          AbortSignal.timeout(240_000), { priorAssistantContext: true, inputVariant: variant, sideQuery: transport }, observation)
        const reason = boundedReason(result.reason)
        const lastStage = stageDecisions.at(-1)
        if (result.stage === 'fast' && lastStage && 'shouldBlock' in lastStage && reason !== undefined) lastStage.reason = reason
        if (args.live) samples.push({ id: testCase.id, expect: testCase.expect, variant, repeat, shouldBlock: result.shouldBlock,
          unavailable: result.unavailable === true,
          invalid: result.autoModeOutcome === 'automode-parsing-error' || result.autoModeOutcome === 'interrupted', model: result.model, requestedModel: args.model,
          durationMs: performance.now() - start, reason, stageDecisions })
      } catch (error) {
        if (!args.live) throw error
        samples.push({ id: testCase.id, expect: testCase.expect, variant, repeat, shouldBlock: true, unavailable: true, invalid: false,
          model: args.model!, requestedModel: args.model, durationMs: performance.now() - start, stageDecisions,
          error: boundedReason(error instanceof Error ? error.message : String(error)) })
      }
      const { missing, unexpected, components } = inspectPayloadEvidence(testCase, variant, captured)
      evidenceReports.push({ id: testCase.id, variant, repeat, stages: captured.length, requestedModels, stageChars: captured.map(r => JSON.stringify(r).length),
        digests: captured.map(requestDigest), missing, unexpected, components })
      if (args.live) console.error(JSON.stringify({ progress: `${testCase.id}/${variant}`, completed: samples.length,
        total: cases.length * 2 * args.repeats, reviewerRequestsAttempted: (resumed?.priorAttempts ?? 0) + (pinned?.requestsAttempted ?? 0),
        backendSends: (resumed?.priorBackendSends ?? 0) + (pinned?.backendSends ?? 0) }))
      const latest = samples.at(-1)
      if (args.live && latest && (latest.unavailable || latest.invalid || latest.error !== undefined)) {
        stoppedEarly = 'Reviewer unavailable or invalid; stopping before any further case'
        break evaluation
      }
    }
  }
  const structuralFailures = evidenceReports.filter(r => r.missing.length || r.unexpected.length)
  const unchangedCandidatePairs: string[] = []
  const evidencePairs = new Map<string, Partial<Record<Variant, EvidenceRecord>>>()
  for (const evidence of evidenceReports) {
    const key = `${evidence.id}/${evidence.repeat}`
    const pair = evidencePairs.get(key) ?? {}
    pair[evidence.variant] = evidence
    evidencePairs.set(key, pair)
  }
  for (const [key, pair] of evidencePairs) {
    if (pair.full && pair.reduced && JSON.stringify(pair.full.digests) === JSON.stringify(pair.reduced.digests)) unchangedCandidatePairs.push(key)
  }
  const comparison = args.live ? compareSamples(samples) : null
  const { componentFailures, componentReductions } = comparePayloadEvidence(cases, evidenceReports)
  const pairedComparisonPassed = comparison?.eligibleForReduction === true && samples.length === cases.length * 2 * args.repeats &&
    stoppedEarly === null && structuralFailures.length === 0 && componentFailures.length === 0 && unchangedCandidatePairs.length === 0
  const evaluationScope = args.only ? 'case' : 'corpus'
  const eligibleForReduction = evaluationScope === 'corpus' && pairedComparisonPassed
  const report = { schema: 1, mode: args.live ? 'live' : 'offline-evidence-only', cases: cases.length, repeats: args.repeats,
    model: args.model ?? 'gpt-6-luna', account: accountIdentity,
    corpusDigest, caseManifest: cases.map(c => ({ id: c.id, expect: c.expect })), authorizedMaxRequests: args.maxRequests,
    transport: args.live ? 'pinned-production-codex-adapter-without-attribution-header' : 'offline-capture',
    reviewerRequestsAttempted: (resumed?.priorAttempts ?? 0) + (pinned?.requestsAttempted ?? 0),
    backendSends: (resumed?.priorBackendSends ?? 0) + (pinned?.backendSends ?? 0),
    transportFailures: [...(resumed?.priorTransportFailures ?? []), ...(pinned?.failures ?? [])], resumeHistory: resumed?.resumeHistory ?? [], stoppedEarly,
    accuracyMeasured: args.live && samples.some(s => !s.unavailable && !s.invalid && s.error === undefined),
    latencyMeasured: args.live && samples.some(s => !s.unavailable && !s.invalid && s.error === undefined), structuralFailures: structuralFailures.length,
    candidateChanged: unchangedCandidatePairs.length === 0, unchangedCandidatePairs,
    evaluationScope, pairedComparisonPassed, eligibleForReduction, componentFailures, componentReductions, evidence: evidenceReports, comparison, samples }
  if (args.out) await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = stoppedEarly || structuralFailures.length || componentFailures.length || unchangedCandidatePairs.length || (args.live && !pairedComparisonPassed) ? 1 : 0
} finally {
  restoreTransportFetch?.()
  process.chdir(previousCwd)
  if (offlineHome) await rm(offlineHome, { recursive: true, force: true })
}
