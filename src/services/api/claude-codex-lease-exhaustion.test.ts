import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryModelWithStreaming } from './claude.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
} from './codexAccountPool.js'
import type { PoolAccount } from './codexAccountPool.js'
import { resetCodexLeaseManagerForTest } from './codexAccountLeaseManager.js'

function buildCodexToken(accountId: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? buildCodexToken(overrides.accountId),
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 5 * 60_000,
    source: overrides.source ?? 'config',
    status: overrides.status ?? 'healthy',
    statusReason: overrides.statusReason,
    lastUsedAt: overrides.lastUsedAt ?? 0,
    credentialGeneration: overrides.credentialGeneration ?? 0,
    credentialGenerationState:
      overrides.credentialGenerationState ??
      (overrides.credentialGeneration === undefined ||
      overrides.credentialGeneration === 0
        ? 'legacy_unbound'
        : 'lifecycle_bound'),
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageAllowed: overrides.usageAllowed,
    usageLimitReached: overrides.usageLimitReached,
    usageFetchedAt:
      'usageFetchedAt' in overrides ? overrides.usageFetchedAt : Date.now(),
    planType: overrides.planType,
    planExpiresAt: overrides.planExpiresAt,
  }
}

describe('lazy subagent Codex lease registration', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalFixturesRoot = process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  let fixturesRoot: string | undefined

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
    if (originalFixturesRoot === undefined) {
      delete process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
    } else {
      process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = originalFixturesRoot
    }
    if (fixturesRoot) {
      rmSync(fixturesRoot, { recursive: true, force: true })
      fixturesRoot = undefined
    }
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
  })

  test('surfaces pool exhaustion as a classified assistant message', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    // Without an isolated root the VCR recorder writes into the repo and the
    // replay masks the real code path on the next run.
    fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-lease-vcr-'))
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
    seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount({
          accountId: 'capped-a',
          alias: 'a',
          status: 'capped',
          statusReason: 'usage_cap',
        }),
        buildPoolAccount({
          accountId: 'capped-b',
          alias: 'b',
          status: 'capped',
          statusReason: 'usage_cap',
        }),
      ],
    })

    const events: unknown[] = []
    for await (const event of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'gpt-5.6-luna',
        provider: 'firstParty',
        isNonInteractiveSession: true,
        querySource: 'agent:test',
        agentId: asAgentId('subagent-under-test'),
        agents: [],
        hasAppendSystemPrompt: false,
        fetchOverride: async () => {
          throw new Error('no request should be dispatched')
        },
        mcpTools: [],
      },
    })) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    const message = events[0] as {
      type: string
      error?: string
      isApiErrorMessage?: boolean
      message: { content: Array<{ type: string; text: string }> }
    }
    expect(message.type).toBe('assistant')
    expect(message.isApiErrorMessage).toBe(true)
    expect(message.error).toBe('rate_limit')
    expect(message.message.content[0]?.text).toBe(
      'Codex account usage limit reached and no healthy replacement profile is available. Switch accounts or wait for usage to reset.',
    )
  })
})
