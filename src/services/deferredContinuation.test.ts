import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodexStatus, CodexStatusDecisionAction } from './api/codexStatus.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './api/codexAccountPool.js'
import { invalidateUsageCache } from './api/codexUsage.js'
import {
  evaluateDeferredContinuationEligibility,
  findLatestMainTerminalFailure,
  parseDeferredTerminalFailure,
  acquireDeferredContinuationLocks,
  createPendingDeferredContinuation,
  deferredContinuationHistorySchema,
  deferredContinuationJobSchema,
  deferredContinuationResultSchema,
  DEFERRED_CONTINUATION_HISTORY_RETENTION_MS,
  pruneDeferredContinuationHistory,
  DEFERRED_LOCK_STALE_MS,
  DEFERRED_SCAN_INTERVAL_MS,
  discardUnreadableDeferredContinuation,
  ensureDeferredContinuationStore,
  getDeferredContinuationLockTargets,
  getDeferredContinuationPaths,
  getLatestDeferredContinuationHistory,
  listDueDeferredContinuations,
  moveDeferredContinuationToHistory,
  prepareHumanPromptAgainstDeferredContinuation,
  readPendingDeferredContinuation,
  readTrustedDeferredTranscript,
  recordDeferredContinuationNotice,
  reconcileSubmittedDeferredContinuation,
  shouldScannerAttemptLock,
  takeDeferredContinuationNotice,
} from './deferredContinuation.js'
import {
  _forTest as deferredRunnerForTest,
  beginForegroundDeferredContinuation,
  settleForegroundDeferredAttempt,
} from './deferredContinuationRunner.js'
import type { AssistantMessage, Message } from '../types/message.js'

const NOW = 1_700_000_000_000
const cleanup: string[] = []

afterEach(async () => {
  deferredRunnerForTest.clearForegroundRegistrations()
  resetCodexAccountPoolForTest()
  invalidateUsageCache()
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

  test('keeps a capped in-memory pool while observing eligibility', async () => {
    const now = Date.now()
    const resetAtSeconds = Math.floor((now + 3_600_000) / 1000)
    const account: PoolAccount = {
      accountId: 'capped-account',
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: now + 60_000,
      source: 'config',
      status: 'capped',
      statusReason: 'usage_cap',
      lastUsedAt: 0,
      cappedAt: now - 1,
      usageResetAt: resetAtSeconds,
    }
    seedCodexAccountPoolForTest({ accounts: [account] })
    invalidateUsageCache()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('test must not reach a provider endpoint')
    }) as typeof globalThis.fetch

    try {
      const eligibility = await evaluateDeferredContinuationEligibility({
        messages: [{ ...terminalMessage(), deferredTerminalFailure: {
          ...terminalMessage().deferredTerminalFailure,
          observedAt: now - 1,
        } }],
        model: 'gpt-5.6-terra',
        now,
      })

      expect(eligibility).toMatchObject({ action: 'schedule' })
      expect(getPoolStatus().accounts[0]?.status).toBe('capped')
    } finally {
      globalThis.fetch = originalFetch
    }
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

  // F2: an unreadable pending record was a one-way trap. It cannot be moved to
  // history (that needs a parsed job), so cancel could not clear it, while
  // prepareHumanPromptAgainstDeferredContinuation refused every prompt for as
  // long as it existed — and the refusal told the user to "continue manually",
  // the one thing it forbids. Meanwhile the resume guard lets you back INTO the
  // session. Only deleting the file by hand escaped.
  describe('unreadable pending record', () => {
    async function withCorruptRecord(): Promise<{
      paths: ReturnType<typeof getDeferredContinuationPaths>
      sessionId: string
    }> {
      const root = await mkdtemp('/tmp/cat-code-deferred-unreadable-')
      cleanup.push(root)
      const paths = getDeferredContinuationPaths(join(root, 'queue'))
      await ensureDeferredContinuationStore(paths)
      const sessionId = job().sessionId
      // Valid JSON, invalid schema — readable bytes are not a readable record,
      // which is the case that strands a session.
      await writeFile(join(paths.pending, `${sessionId}.json`), '{"version":1}\n', {
        mode: 0o600,
      })
      return { paths, sessionId }
    }

    test('is refused with an exit the user can actually take', async () => {
      const root = await mkdtemp('/tmp/cat-code-deferred-unreadable-env-')
      cleanup.push(root)
      const previous = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = root
      try {
        // prepareHumanPrompt takes no paths argument, so the store must be the
        // one derived from the env.
        const paths = getDeferredContinuationPaths()
        await ensureDeferredContinuationStore(paths)
        const sessionId = job().sessionId
        await writeFile(join(paths.pending, `${sessionId}.json`), '{"version":1}\n', {
          mode: 0o600,
        })
        const decision = await prepareHumanPromptAgainstDeferredContinuation(sessionId)
        expect(decision.action).toBe('block')
        // The refusal must name the exit, not prescribe the impossible.
        expect(decision.action === 'block' && decision.notice).toContain(
          '/continue-after-limit cancel',
        )
        expect(decision.action === 'block' && decision.notice).not.toContain(
          'continue manually',
        )
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previous
      }
    })

    test('can be discarded, which reopens the session', async () => {
      const { paths, sessionId } = await withCorruptRecord()
      await expect(readPendingDeferredContinuation(sessionId, paths)).rejects.toThrow()

      expect(await discardUnreadableDeferredContinuation(sessionId, paths)).toBe(true)

      // The trap is gone: the record no longer exists and prompts flow again.
      expect(await readPendingDeferredContinuation(sessionId, paths)).toBeNull()
      expect(await discardUnreadableDeferredContinuation(sessionId, paths)).toBe(false)
    })

    test('never discards a record that reads back fine', async () => {
      const root = await mkdtemp('/tmp/cat-code-deferred-readable-')
      cleanup.push(root)
      const paths = getDeferredContinuationPaths(join(root, 'queue'))
      const pending = job({ notBefore: NOW - 1 })
      await createPendingDeferredContinuation(pending, paths)

      // Between a caller's failed read and this call the file may have been
      // rewritten; discarding a live schedule the user never cancelled would be
      // worse than the trap.
      expect(await discardUnreadableDeferredContinuation(pending.sessionId, paths)).toBe(false)
      expect((await readPendingDeferredContinuation(pending.sessionId, paths))?.jobId).toBe(
        pending.jobId,
      )
    })

    test('refuses while an owner is running the session', async () => {
      const { paths, sessionId } = await withCorruptRecord()
      // The job ID lives inside the record we cannot parse, so the SESSION lock
      // is the only one that answers "is an owner running this right now?".
      const guard = await acquireDeferredContinuationLocks(
        { jobId: job().jobId, sessionId },
        paths,
      )
      try {
        await expect(
          discardUnreadableDeferredContinuation(sessionId, paths),
        ).rejects.toThrow()
      } finally {
        await guard.release()
      }
      // Once the owner is gone, the exit works.
      expect(await discardUnreadableDeferredContinuation(sessionId, paths)).toBe(true)
    })
  })

  test('authority loss after history write cannot unlink the pending record', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-history-authority-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    const pending = job({ notBefore: NOW - 1 })
    await createPendingDeferredContinuation(pending, paths)
    let checks = 0

    await expect(
      moveDeferredContinuationToHistory(
        pending,
        'completed',
        'completed',
        NOW,
        paths,
        {
          assertHealthy() {
            checks++
            if (checks > 1) throw new Error('authority lost between substeps')
          },
        },
      ),
    ).rejects.toThrow('authority lost between substeps')

    expect(await stat(join(paths.pending, `${pending.sessionId}.json`))).toBeDefined()
    expect(await stat(join(paths.history, `${pending.jobId}.json`))).toBeDefined()
  })

  test('durable terminal history makes a surviving pending record non-executable', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-terminal-authority-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    const pending = job({ notBefore: NOW - 1 })
    await createPendingDeferredContinuation(pending, paths)
    await writeFile(
      join(paths.history, `${pending.jobId}.json`),
      `${JSON.stringify({
        ...pending,
        terminalState: 'canceled',
        terminalReason: 'command',
        terminalAt: NOW,
      })}\n`,
      { mode: 0o600 },
    )

    expect(await readPendingDeferredContinuation(pending.sessionId, paths)).toBeNull()
    expect(await listDueDeferredContinuations(NOW, paths)).toEqual([])
    expect((await getLatestDeferredContinuationHistory(pending.sessionId, paths))?.terminalState).toBe('canceled')

    await writeFile(
      join(paths.history, `${pending.jobId}.json`),
      `${JSON.stringify({
        ...pending,
        sessionId: '44444444-4444-4444-8444-444444444444',
        terminalState: 'canceled',
        terminalReason: 'command',
        terminalAt: NOW,
      })}\n`,
      { mode: 0o600 },
    )
    expect(await readPendingDeferredContinuation(pending.sessionId, paths)).toBeNull()
    expect(await listDueDeferredContinuations(NOW, paths)).toEqual([])
  })

  test('history retention removes only aged records nothing still relies on', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-retention-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    await ensureDeferredContinuationStore(paths)
    const writeHistory = async (jobId: string, terminalAt: number) =>
      writeFile(
        join(paths.history, `${jobId}.json`),
        `${JSON.stringify({
          ...job({ jobId }),
          terminalState: 'completed',
          terminalReason: 'completed',
          terminalAt,
        })}\n`,
        { mode: 0o600 },
      )
    const aged = NOW - DEFERRED_CONTINUATION_HISTORY_RETENTION_MS - 1
    await writeHistory('55555555-5555-4555-8555-555555555555', aged)
    await writeHistory('66666666-6666-4666-8666-666666666666', NOW - 1_000)

    expect(await pruneDeferredContinuationHistory(NOW, paths)).toBe(1)
    expect(
      await lstat(join(paths.history, '66666666-6666-4666-8666-666666666666.json')),
    ).toBeDefined()
    await expect(
      lstat(join(paths.history, '55555555-5555-4555-8555-555555555555.json')),
    ).rejects.toThrow()
  })

  test('history retention never removes a tombstone still suppressing a pending record', async () => {
    // moveDeferredContinuationToHistory writes history before unlinking
    // pending, so a crash between those steps leaves both files and the
    // history record is the only thing keeping the terminal job
    // non-executable. Age alone must never delete it.
    const root = await mkdtemp('/tmp/cat-code-deferred-retention-tombstone-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    const stranded = job({ notBefore: NOW - 1 })
    await createPendingDeferredContinuation(stranded, paths)
    const aged = NOW - DEFERRED_CONTINUATION_HISTORY_RETENTION_MS - 1
    await writeFile(
      join(paths.history, `${stranded.jobId}.json`),
      `${JSON.stringify({
        ...stranded,
        terminalState: 'completed',
        terminalReason: 'completed',
        terminalAt: aged,
      })}\n`,
      { mode: 0o600 },
    )

    expect(await pruneDeferredContinuationHistory(NOW, paths)).toBe(0)
    // The decisive assertion: the job stays non-executable after pruning.
    expect(await readPendingDeferredContinuation(stranded.sessionId, paths)).toBeNull()
    expect(await listDueDeferredContinuations(NOW, paths)).toEqual([])
  })

  test('history retention keeps unreadable history rather than making pending work executable', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-retention-malformed-')
    cleanup.push(root)
    const paths = getDeferredContinuationPaths(join(root, 'queue'))
    const stranded = job({ notBefore: NOW - 1 })
    await createPendingDeferredContinuation(stranded, paths)
    await writeFile(join(paths.history, `${stranded.jobId}.json`), 'not json\n', {
      mode: 0o600,
    })

    expect(await pruneDeferredContinuationHistory(NOW, paths)).toBe(0)
    expect(await readPendingDeferredContinuation(stranded.sessionId, paths)).toBeNull()
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

  // F10: `ambiguous` exists to stop AUTOMATIC retry, because replaying could
  // repeat tool actions. A human taking the conversation back is the safe
  // resolution the state is waiting for, so it must clear the job rather than
  // trap it. Before this, every human message was refused with `block` and the
  // record survived, leaving "continue manually" impossible without deleting
  // state by hand.
  test('human input takes over an ambiguous job instead of trapping it', async () => {
    const root = await mkdtemp('/tmp/cat-code-human-ambiguous-')
    cleanup.push(root)
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      await createPendingDeferredContinuation(
        job({
          state: 'ambiguous',
          attempt: { ...job().attempt, submittedAt: NOW },
        }),
      )
      const decision = await prepareHumanPromptAgainstDeferredContinuation(
        job().sessionId,
      )
      expect(decision.action).toBe('allow_after_cancel')
      // The takeover still has to disclose that an attempt may already have run.
      expect(decision.action !== 'allow' && decision.notice).toContain(
        'may have started',
      )
      expect(await readPendingDeferredContinuation(job().sessionId)).toBeNull()
      const history = await getLatestDeferredContinuationHistory(job().sessionId)
      expect(history?.terminalState).toBe('canceled')
      expect(history?.terminalReason).toBe('human_message')
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  // F8: the preflight read is a durable-state input, so an oversized transcript
  // must fail closed with a stated reason instead of being materialized whole
  // (string + split array + every parsed line) and risking an OOM kill that
  // leaves the job pending for the minute worker to retry forever.
  test('trusted transcript read fails closed above its byte bound', async () => {
    const root = await mkdtemp('/tmp/cat-code-transcript-bound-')
    cleanup.push(root)
    await chmod(root, 0o700)
    const project = join(root, job().projectStorageKey)
    await mkdir(project, { mode: 0o700 })
    const line = `${JSON.stringify({ type: 'user', uuid: job().attempt.messageUuid })}\n`
    await writeFile(join(project, `${job().sessionId}.jsonl`), line.repeat(64), {
      mode: 0o600,
    })
    await expect(
      readTrustedDeferredTranscript(job(), root, 16),
    ).rejects.toThrow('too large')
    expect(
      await readTrustedDeferredTranscript(job(), root, line.length * 64),
    ).toHaveLength(64)
  })

  // The reader is chunked, so a JSON line straddling a chunk boundary — and a
  // multi-byte character split across one — must still parse exactly.
  test('trusted transcript read reassembles lines across chunk boundaries', async () => {
    const root = await mkdtemp('/tmp/cat-code-transcript-chunks-')
    cleanup.push(root)
    await chmod(root, 0o700)
    const project = join(root, job().projectStorageKey)
    await mkdir(project, { mode: 0o700 })
    // Comfortably larger than the reader's chunk size, with a multi-byte
    // character at the end so a naive per-chunk decode would corrupt it.
    const wide = { type: 'user', uuid: job().attempt.messageUuid, text: `${'x'.repeat(2 * 1024 * 1024)}é` }
    await writeFile(
      join(project, `${job().sessionId}.jsonl`),
      `${JSON.stringify({ type: 'system' })}\n${JSON.stringify(wide)}\n`,
      { mode: 0o600 },
    )
    const entries = await readTrustedDeferredTranscript(job(), root)
    expect(entries).toHaveLength(2)
    expect(entries[1]).toEqual(wide)
    // The decisive check: reconciliation still sees the attempt's user message.
    expect(
      reconcileSubmittedDeferredContinuation(
        job({ state: 'submitted', attempt: { ...job().attempt, submittedAt: NOW } }),
        entries,
      ),
    ).toEqual({ action: 'mark_ambiguous' })
  })

  // F17: a TERMINAL barrier failure leaves the job `submitted` (plan line 576) —
  // the result entry may or may not have reached the transcript, so the runner
  // must not guess. Startup reconciliation reads the transcript for a terminal
  // descendant and decides (plan line 604). Only a PRE-PROVIDER barrier failure
  // stops for attention. This test previously asserted the opposite; its old
  // name ("instead of stranding submitted") records that the divergence was
  // deliberate rather than accidental.
  //
  // Mechanism note: no switchSession() here, so persistence actually fails at
  // the result-entry validator (recordDeferredContinuationResult's sessionId
  // check, sessionStorage.ts:1993) rather than at the durable barrier. The
  // asserted transition is identical for either failure, which is what this
  // pins — see the sibling test in deferredContinuationRunner.test.ts.
  test('foreground terminal-barrier failure leaves the job submitted for reconciliation', async () => {
    const root = await mkdtemp('/tmp/cat-code-result-journal-failure-')
    cleanup.push(root)
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    try {
      const pending = job({ notBefore: NOW - 1 })
      await createPendingDeferredContinuation(pending)
      const attempt = await beginForegroundDeferredContinuation(pending)
      expect(attempt).not.toBeNull()
      expect(settleForegroundDeferredAttempt(attempt!.command.origin, {
        outcome: 'completed',
        observedAt: NOW,
      })).toBe(true)
      await attempt!.finished

      expect((await readPendingDeferredContinuation(pending.sessionId))?.state).toBe('submitted')
      expect(await getLatestDeferredContinuationHistory(pending.sessionId)).toBeNull()
      expect(await takeDeferredContinuationNotice(pending.sessionId)).toBeNull()
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
