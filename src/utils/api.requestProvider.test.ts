import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resetStateForTests, setSessionProvider } from '../bootstrap/state.js'
import type { Tool } from '../Tool.js'
import { toolToAPISchema } from './api.js'
import { clearToolSchemaCache, getToolSchemaCache } from './toolSchemaCache.js'

/**
 * A Claude-family model: `getProviderForModel` returns null for it, so the
 * request provider is whatever the caller supplies. That is the only shape in
 * which the caller's provider and the process-global session provider can
 * disagree, and it is exactly what `runAgent.ts:764` hands a background child
 * spawned by a gpt worker (`mainLoopProvider: 'openai'`, non-gpt model).
 */
const CLAUDE_MODEL = 'claude-opus-5-20260401'

/** Dash-prefixed property: renamed only on the OpenAI path. */
const TOOL_NAME = 'ProviderScopingProbeTool'

function probeTool(): Tool {
  return {
    name: TOOL_NAME,
    inputJSONSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        '-A': { type: 'number' },
      },
      required: ['pattern'],
    },
    // Echoes the provider it was rendered for, so the description text the
    // model would actually receive is directly observable.
    async prompt({ provider }: { provider?: string }) {
      return `rendered-for:${provider}`
    },
  } as unknown as Tool
}

async function renderFor(
  provider: 'openai' | 'firstParty' | undefined,
): Promise<Record<string, unknown>> {
  return (await toolToAPISchema(probeTool(), {
    getToolPermissionContext: async () => ({}) as never,
    tools: [],
    agents: [],
    model: CLAUDE_MODEL,
    provider,
  })) as unknown as Record<string, unknown>
}

describe('toolToAPISchema request provider scoping', () => {
  beforeEach(() => {
    resetStateForTests()
    clearToolSchemaCache()
    // The parent session sits on Anthropic while the worker runs on Codex.
    setSessionProvider('firstParty')
  })

  afterEach(() => {
    clearToolSchemaCache()
    resetStateForTests()
  })

  test('renders the OpenAI schema for a Codex worker on a Claude model while the session is on Anthropic', async () => {
    const schema = await renderFor('openai')

    expect(schema.description).toBe('rendered-for:openai')
    expect(
      Object.keys(
        (schema.input_schema as { properties: Record<string, unknown> })
          .properties,
      ),
    ).toEqual(['pattern', 'lines_after'])
  })

  test('does not poison the process-wide schema cache for correctly routed callers', async () => {
    const codexSchema = await renderFor('openai')
    const anthropicSchema = await renderFor('firstParty')

    expect(codexSchema.description).toBe('rendered-for:openai')
    expect(anthropicSchema.description).toBe('rendered-for:firstParty')
    expect(codexSchema.description).not.toBe(anthropicSchema.description)

    const keys = [...getToolSchemaCache().keys()]
    expect(keys.filter(k => k.startsWith('openai:')).length).toBe(1)
    expect(keys.filter(k => k.startsWith('firstParty:')).length).toBe(1)
  })
})
