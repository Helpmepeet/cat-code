import { describe, expect, test } from 'bun:test'
import { parseAgentsFlag, parseAgentsFromJson } from './loadAgentsDir.js'

// A --agents payload that was malformed, or that held a definition the schema
// rejects, used to vanish: the parse returned [] and the session started with
// no CLI agents and no message. These pin that every rejection is reported.

const VALID_PAYLOAD = {
  reviewer: {
    description: 'Reviews code',
    prompt: 'You review code.',
    tools: ['Read', 'Grep'],
  },
}

describe('parseAgentsFromJson', () => {
  test('a valid payload loads its agents and reports no errors', () => {
    const result = parseAgentsFromJson(VALID_PAYLOAD, 'flagSettings')

    expect(result.errors).toEqual([])
    expect(result.agents.map(agent => agent.agentType)).toEqual(['reviewer'])
    expect(result.agents[0]?.whenToUse).toBe('Reviews code')
    expect(result.agents[0]?.tools).toEqual(['Read', 'Grep'])
    expect(result.agents[0]?.source).toBe('flagSettings')
  })

  test('a definition missing a required field is reported by name', () => {
    const result = parseAgentsFromJson({ reviewer: { prompt: 'You review.' } })

    expect(result.agents).toEqual([])
    expect(result.errors.join('\n')).toContain('reviewer.description')
  })

  test('a definition with an empty prompt is reported by field', () => {
    const result = parseAgentsFromJson({
      reviewer: { description: 'Reviews code', prompt: '' },
    })

    expect(result.agents).toEqual([])
    expect(result.errors.join('\n')).toContain(
      'reviewer.prompt: Prompt cannot be empty',
    )
  })

  test('one bad definition rejects the whole payload', () => {
    const result = parseAgentsFromJson({
      ...VALID_PAYLOAD,
      broken: { description: 'Broken' },
    })

    expect(result.agents).toEqual([])
    expect(result.errors.join('\n')).toContain('broken.prompt')
  })

  test('a payload that is not an object of agents is reported', () => {
    const result = parseAgentsFromJson('reviewer')

    expect(result.agents).toEqual([])
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test('reported errors carry no em dash', () => {
    const result = parseAgentsFromJson({ reviewer: { prompt: '' } })

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.join('\n')).not.toContain('—')
  })
})

describe('parseAgentsFlag', () => {
  test('a valid JSON string loads its agents unchanged', () => {
    const result = parseAgentsFlag(JSON.stringify(VALID_PAYLOAD))

    expect(result.errors).toEqual([])
    expect(result.agents.map(agent => agent.agentType)).toEqual(['reviewer'])
    expect(result.agents[0]?.tools).toEqual(['Read', 'Grep'])
  })

  test('malformed JSON is reported instead of swallowed', () => {
    const result = parseAgentsFlag('{"reviewer": ')

    expect(result.agents).toEqual([])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('--agents is not valid JSON')
  })

  test('well formed JSON holding an invalid definition is reported', () => {
    const result = parseAgentsFlag(
      JSON.stringify({ reviewer: { description: 'Reviews code' } }),
    )

    expect(result.agents).toEqual([])
    expect(result.errors.join('\n')).toContain('reviewer.prompt')
  })

  test('JSON that parses to null is reported, not treated as empty', () => {
    const result = parseAgentsFlag('null')

    expect(result.agents).toEqual([])
    expect(result.errors.length).toBeGreaterThan(0)
  })
})
