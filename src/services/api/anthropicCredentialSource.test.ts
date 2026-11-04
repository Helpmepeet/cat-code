import { expect, test } from 'bun:test'
import { resolveAnthropicCredentialSource } from './anthropicCredentialSource.js'

type Routing = NonNullable<Parameters<typeof resolveAnthropicCredentialSource>[0]>
function route(over: Partial<Routing> = {}): Routing {
  return {
    getProvider: () => 'firstParty',
    getAuthTokenSource: () => ({ source: 'none', hasToken: false }),
    getApiKeySource: () => ({ source: 'none', key: null }),
    isSubscriber: () => false,
    hasStoredRoute: () => false,
    env: {},
    ...over,
  }
}

test('cloud provider routing wins before credential readers', () => {
  for (const provider of ['bedrock', 'vertex', 'foundry'] as const) {
    expect(resolveAnthropicCredentialSource(route({
      getProvider: () => provider,
      getAuthTokenSource: () => { throw new Error('must not read') },
    }))).toEqual({ kind: provider })
  }
})

test('bound subscription wins over a legacy managed API key', () => {
  expect(resolveAnthropicCredentialSource(route({
    hasStoredRoute: () => true,
    getApiKeySource: () => ({ source: '/login managed key', key: 'secret' }),
  }))).toEqual({ kind: 'claude_subscription' })
})

test('external bearer and helper routes win over API keys without helper execution', () => {
  for (const source of ['ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper'] as const) {
    const result = resolveAnthropicCredentialSource(route({
      getAuthTokenSource: () => ({ source, hasToken: true }),
      getApiKeySource: () => { throw new Error('must not read') },
    }))
    expect(result).toEqual(source === 'apiKeyHelper'
      ? { kind: 'api_key_helper' }
      : { kind: 'environment_token', variableName: source })
  }
})

test('selected OAuth environment and FD sources are redacted', () => {
  for (const source of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CCR_OAUTH_TOKEN_FILE'] as const) {
    const result = resolveAnthropicCredentialSource(route({
      isSubscriber: () => true,
      getAuthTokenSource: () => ({ source, hasToken: true }),
    }))
    expect(result).toEqual(source === 'CLAUDE_CODE_OAUTH_TOKEN'
      ? { kind: 'environment_token', variableName: source }
      : source === 'CCR_OAUTH_TOKEN_FILE'
        ? { kind: 'file_descriptor' }
        : { kind: 'file_descriptor', variableName: source })
  }
})

test('API source routing ignores unselected env keys and never returns values', () => {
  const env = { ANTHROPIC_API_KEY: 'env-secret', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '42' }
  for (const [source, key, expected] of [
    ['ANTHROPIC_API_KEY', 'env-secret', { kind: 'environment_api_key', variableName: 'ANTHROPIC_API_KEY' }],
    ['ANTHROPIC_API_KEY', 'fd-secret', { kind: 'file_descriptor', variableName: 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR' }],
    ['apiKeyHelper', null, { kind: 'api_key_helper' }],
    ['/login managed key', 'managed-secret', { kind: 'managed_api_key' }],
    ['none', null, { kind: 'none' }],
  ] as const) {
    const result = resolveAnthropicCredentialSource(route({
      env, getApiKeySource: () => ({ source, key }),
    }))
    expect(result).toEqual(expected)
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('42')
  }
})
