import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodexStatus, CodexStatusDecisionAction } from './api/codexStatus.js'
import {
  evaluateDeferredContinuationEligibility,
  findLatestMainTerminalFailure,
  parseDeferredTerminalFailure,
  acquireDeferredContinuationLocks,
  createPendingDeferredContinuation,
  deferredContinuationHistorySchema,
  deferredContinuationJobSchema,
  deferredContinuationResultSchema,
  DEFERRED_LOCK_STALE_MS,
  DEFERRED_SCAN_INTERVAL_MS,
  ensureDeferredContinuationStore,
  getDeferredContinuationLockTargets,
  getDeferredContinuationPaths,
  getLatestDeferredContinuationHistory,
  prepareHumanPromptAgainstDeferredContinuation,
  readPendingDeferredContinuation,
  readTrustedDeferredTranscript,
  recordDeferredContinuationNotice,
  reconcileSubmittedDeferredContinuation,
  shouldScannerAttemptLock,
  takeDeferredContinuationNotice,
} from './deferredContinuation.js'
import type { AssistantMessage, Message } from '../types/message.js'

const NOW = 1_700_000_000_000
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function terminalMessage(code: AssistantMessage['deferredTerminalFailure'] extends infer T
  ? T extends { code: infer C } ? C : never
  : never = 'quota_exhausted'): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    isApiErrorMessage: true,
    message: { role: 'assistant', content: [] },
    deferredTerminalFailure: {
      version: 1,
      provider: 'openai',
      code,
      observedAt: NOW,
    },
  }
}

function status(action: CodexStatusDecisionAction, notBefore: string | null = null): CodexStatus {
  return {
    ok: true,
    schema: 'cat-code.codex.status',
    version: 1,
    observed_at: new Date(NOW).toISOString(),
    observation_id: 'obs_test',
    advisory: true,
    observation: {
      scope: 'standalone_process',
      cap_state_shared_with_next_process: false,
      reservation: false,
      usage_refresh: 'none',
      credential_refresh: 'not_attempted',
      next_probe_after: null,
    },
    decision: {
      action,
      reason_code:
        action === 'delegate' ? 'candidate_available'
        : action === 'wait' ? 'quota_blocked_reset_known'
        : action === 'recheck' ? 'quota_blocked_no_reset'
        : action === 'attempt' ? 'observation_uncertain'
        : 'all_auth_blocked',
      not_before: notBefore,
      predicted_initial_profile_ref: null,
      best_observed_candidate_profile_ref: null,
    },
    pool: {
      profiles_total: 1,
      candidate: action === 'delegate' ? 1 : 0,
      quota_blocked: action === 'wait' || action === 'recheck' ? 1 : 0,
      auth_blocked: action === 'human_recovery' ? 1 : 0,
      transient_blocked: action === 'attempt' ? 1 : 0,
      unknown: 0,
      earliest_known_reset_at: notBefore,
    },
    profiles: [],
  }
}

describe('deferred continuation eligibility', () => {
  test('runtime narrowing rejects malformed envelopes', () => {
    expect(parseDeferredTerminalFailure({ version: 1, provider: 'openai', code: 'quota_exhausted' })).toBeNull()
    expect(parseDeferredTerminalFailure({ version: 1, provider: 'openai', code: 'made_up', observedAt: NOW })).toBeNull()
  })

  test('uses only the latest main-chain terminal API failure', () => {
    const messages: Message[] = [
      terminalMessage(),
      { ...terminalMessage('ambiguous_rate_limit'), uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    ]
    expect(findLatestMainTerminalFailure(messages)?.code).toBe('ambiguous_rate_limit')
    messages.push({
      type: 'assistant',
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      message: { role: 'assistant', content: [] },
    })
    expect(findLatestMainTerminalFailure(messages)).toBeNull()
  })

  test('rejects non-Codex and non-quota outcomes', async () => {
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'claude-sonnet', baseProvider: 'firstParty' })).reason).toBe('not_codex')
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage('ambiguous_rate_limit')], model: 'gpt-5.6-terra' })).reason).toBe('not_terminal_quota')
  })

  test('maps status decisions without inventing reset evidence', async () => {
    const resetAt = NOW + 3_600_000
    const build = (value: CodexStatus) => async () => value
    expect(await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', now: NOW, buildStatus: build(status('delegate')) })).toEqual({ action: 'run_now', observedAt: NOW })
    expect(await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', now: NOW, buildStatus: build(status('wait', new Date(resetAt).toISOString())) })).toEqual({ action: 'schedule', observedAt: NOW, resetAt, notBefore: resetAt + 60_000 })
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', buildStatus: build(status('attempt')) })).reason).toBe('observation_uncertain')
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', buildStatus: build(status('recheck')) })).reason).toBe('quota_reset_unknown')
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', buildStatus: build(status('human_recovery')) })).reason).toBe('account_recovery')
  })

  test('rejects stale, malformed, and zero reset observations and starts past resets now', async () => {
    const stale = status('delegate')
    stale.observed_at = new Date(NOW - 1).toISOString()
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', buildStatus: async () => stale })).reason).toBe('observation_uncertain')

    const malformed = status('wait', 'not-a-time')
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', buildStatus: async () => malformed })).reason).toBe('quota_reset_unknown')

    const zero = status('wait', new Date(0).toISOString())
    expect((await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', buildStatus: async () => zero })).reason).toBe('quota_reset_unknown')

    const elapsed = status('wait', new Date(NOW - 120_000).toISOString())
    expect(await evaluateDeferredContinuationEligibility({ messages: [terminalMessage()], model: 'gpt-5.6-terra', now: NOW, buildStatus: async () => elapsed })).toMatchObject({ action: 'schedule', notBefore: NOW })
  })
})

function job(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    projectStorageKey: '-private-project',
    context: {
      cwd: '/private/project',
      model: 'gpt-5.6-terra',
      effort: 'high' as const,
      permissionMode: 'default' as const,
    },
    createdAt: NOW,
    statusObservedAt: NOW,
    scheduleReason: 'hard_quota_reset' as const,
    resetAt: NOW + 60_000,
    notBefore: NOW + 120_000,
    state: 'pending' as const,
    attempt: {
      number: 1,
      messageUuid: '33333333-3333-4333-8333-333333333333',
    },
    transientRetries: 0,
    ...overrides,
  }
}

describe('deferred continuation durable store', () => {
  test('strict schema rejects paths, secrets, malformed timestamps, and state mismatches', () => {
    expect(deferredContinuationJobSchema.safeParse({ ...job(), transcriptPath: '/tmp/x' }).success).toBe(false)
    expect(deferredContinuationJobSchema.safeParse({ ...job(), token: 'secret' }).success).toBe(false)
    expect(deferredContinuationJobSchema.safeParse({ ...job(), projectStorageKey: '../escape' }).success).toBe(false)
    expect(deferredContinuationJobSchema.safeParse({ ...job(), notBefore: Number.NaN }).success).toBe(false)
    expect(deferredContinuationJobSchema.safeParse({ ...job(), state: 'submitted' }).success).toBe(false)
    expect(deferredContinuationJobSchema.safeParse({ ...job(), context: { ...job().context, effort: 'xhigh' } }).success).toBe(true)
    expect(deferredContinuationJobSchema.safeParse({ ...job(), context: { ...job().context, effort: 'ultra' } }).success).toBe(true)
  })

  test('one pending record per session survives round trip with private modes', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-store-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    await createPendingDeferredContinuation(job(), paths)
    expect(await readPendingDeferredContinuation(job().sessionId, paths)).toEqual(job())
    await expect(createPendingDeferredContinuation(job(), paths)).rejects.toThrow('already exists')
    expect(JSON.stringify(await readPendingDeferredContinuation(job().sessionId, paths))).not.toContain('secret')
    expect((await stat(paths.root)).mode & 0o077).toBe(0)
    expect((await stat(join(paths.pending, `${job().sessionId}.json`))).mode & 0o077).toBe(0)
  })

  test('distinct jobs for one session serialize on the session lock and cannot both create', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-create-race-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    const other = job({ jobId: '44444444-4444-4444-8444-444444444444' })
    const results = await Promise.allSettled([
      createPendingDeferredContinuation(job(), paths),
      createPendingDeferredContinuation(other, paths),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await readPendingDeferredContinuation(job().sessionId, paths)).not.toBeNull()
  })

  test('job then session lock admits exactly one owner', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-lock-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    const first = await acquireDeferredContinuationLocks(job(), paths)
    await expect(acquireDeferredContinuationLocks(job(), paths)).rejects.toThrow()
    first.assertHealthy()
    await first.release()
    const second = await acquireDeferredContinuationLocks(job(), paths)
    await second.release()
  })

  test('per-job targets differ while the execution lock is shared by session', () => {
    const paths = getDeferredContinuationPaths('/tmp/cat-code-lock-targets')
    const first = getDeferredContinuationLockTargets(job(), paths)
    const second = getDeferredContinuationLockTargets(
      job({ jobId: '44444444-4444-4444-8444-444444444444' }),
      paths,
    )
    expect(first.job).not.toBe(second.job)
    expect(first.session).toBe(second.session)
  })

  test('scanner observes an unchanged stale lock on two separated scans before reclaim', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-stale-lock-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    await ensureDeferredContinuationStore(paths)
    const target = getDeferredContinuationLockTargets(job(), paths).job
    await mkdir(`${target}.lock`, { mode: 0o700 })
    const firstNow = NOW + DEFERRED_LOCK_STALE_MS + 1
    await utimes(`${target}.lock`, new Date(NOW), new Date(NOW))
    expect(await shouldScannerAttemptLock(target, firstNow, paths)).toBe(false)
    expect(
      await shouldScannerAttemptLock(
        target,
        firstNow + DEFERRED_SCAN_INTERVAL_MS,
        paths,
      ),
    ).toBe(true)
  })

  test('trusted transcript identity rejects symlinks and accepts a private regular file', async () => {
    const root = await mkdtemp('/tmp/cat-code-projects-')
    cleanup.push(root)
    await chmod(root, 0o700)
    const project = join(root, job().projectStorageKey)
    await mkdir(project, { mode: 0o700 })
    const transcript = join(project, `${job().sessionId}.jsonl`)
    await writeFile(transcript, '{"type":"user","uuid":"ok"}\n', { mode: 0o600 })
    expect(await readTrustedDeferredTranscript(job(), root)).toHaveLength(1)

    await rm(transcript)
    const target = join(root, 'target.jsonl')
    await writeFile(target, '{}\n', { mode: 0o600 })
    await symlink(target, transcript)
    await expect(readTrustedDeferredTranscript(job(), root)).rejects.toThrow('Untrusted')
  })

  test('trusted transcript rejects a symlinked project parent, broad modes, and non-files', async () => {
    const root = await mkdtemp('/tmp/cat-code-project-boundaries-')
    cleanup.push(root)
    await chmod(root, 0o700)
    const targetProject = join(root, 'real-project')
    await mkdir(targetProject, { mode: 0o700 })
    await writeFile(join(targetProject, `${job().sessionId}.jsonl`), '{}\n', { mode: 0o600 })
    await symlink(targetProject, join(root, job().projectStorageKey))
    await expect(readTrustedDeferredTranscript(job(), root)).rejects.toThrow('Untrusted')

    await rm(join(root, job().projectStorageKey))
    await mkdir(join(root, job().projectStorageKey), { mode: 0o755 })
    await expect(readTrustedDeferredTranscript(job(), root)).rejects.toThrow('permissions are too broad')
    await chmod(join(root, job().projectStorageKey), 0o700)
    await mkdir(join(root, job().projectStorageKey, `${job().sessionId}.jsonl`))
    await expect(readTrustedDeferredTranscript(job(), root)).rejects.toThrow('Untrusted')
  })

  test('queue symlinks and broad existing modes fail closed without chmodding the target', async () => {
    const root = await mkdtemp('/tmp/cat-code-queue-boundaries-')
    cleanup.push(root)
    const target = join(root, 'target')
    await mkdir(target, { mode: 0o755 })
    const queue = join(root, 'queue')
    await symlink(target, queue)
    await expect(ensureDeferredContinuationStore(getDeferredContinuationPaths(queue))).rejects.toThrow('not a private directory')
    expect((await lstat(target)).mode & 0o077).not.toBe(0)
  })

  test('sanitized notices are strict, private, and consumed exactly once', async () => {
    const root = await mkdtemp('/tmp/cat-code-notice-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    await expect(recordDeferredContinuationNotice({
      version: 1,
      sessionId: job().sessionId,
      kind: 'needs_attention',
      reason: 'raw provider response' as never,
      observedAt: NOW,
    }, paths)).rejects.toThrow()
    const notice = {
      version: 1 as const,
      sessionId: job().sessionId,
      kind: 'network_retry' as const,
      notBefore: NOW + 60_000,
      retry: 1,
      observedAt: NOW,
    }
    await recordDeferredContinuationNotice(notice, paths)
    expect(await takeDeferredContinuationNotice(job().sessionId, paths)).toEqual(notice)
    expect(await takeDeferredContinuationNotice(job().sessionId, paths)).toBeNull()
  })

  test('human input atomically cancels pending work and blocks submitted work', async () => {
    const root = await mkdtemp('/tmp/cat-code-human-race-')
    cleanup.push(root)
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      await createPendingDeferredContinuation(job())
      expect(await prepareHumanPromptAgainstDeferredContinuation(job().sessionId)).toEqual({
        action: 'allow_after_cancel',
        notice: 'Scheduled continuation canceled because you sent a new message.',
      })
      expect(await readPendingDeferredContinuation(job().sessionId)).toBeNull()
      expect((await getLatestDeferredContinuationHistory(job().sessionId))?.terminalReason).toBe('human_message')

      const submitted = job({
        jobId: '44444444-4444-4444-8444-444444444444',
        state: 'submitted',
        attempt: { ...job().attempt, submittedAt: NOW },
      })
      await createPendingDeferredContinuation(submitted)
      expect((await prepareHumanPromptAgainstDeferredContinuation(job().sessionId)).action).toBe('block')
      expect((await readPendingDeferredContinuation(job().sessionId))?.state).toBe('submitted')
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  test('result schema rejects raw data and crash reconciliation never replays an uncertain attempt', () => {
    const submitted = job({
      state: 'submitted',
      attempt: { ...job().attempt, submittedAt: NOW },
    })
    expect(reconcileSubmittedDeferredContinuation(submitted, [])).toEqual({ action: 'return_pending' })
    const user = { type: 'user', uuid: job().attempt.messageUuid }
    expect(reconcileSubmittedDeferredContinuation(submitted, [user])).toEqual({ action: 'mark_ambiguous' })
    const result = {
      type: 'deferred-continuation-result' as const,
      version: 1 as const,
      sessionId: job().sessionId,
      attemptUuid: job().attempt.messageUuid,
      outcome: 'completed' as const,
      observedAt: NOW,
    }
    expect(deferredContinuationResultSchema.safeParse({ ...result, rawError: 'nope' }).success).toBe(false)
    expect(reconcileSubmittedDeferredContinuation(submitted, [user, result])).toEqual({ action: 'apply_result', result })
    expect(deferredContinuationHistorySchema.safeParse({
      ...submitted,
      terminalState: 'needs_attention',
      terminalReason: 'raw provider response',
      terminalAt: NOW,
    }).success).toBe(false)
  })
})
