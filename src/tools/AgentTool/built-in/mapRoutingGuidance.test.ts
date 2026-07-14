import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAP_ROUTING_GUIDANCE } from './mapRoutingGuidance.js'

describe('built-in agent map routing guidance', () => {
  const promptFiles = [
    'exploreAgent.ts',
    'planAgent.ts',
    'generalPurposeAgent.ts',
    'implementorAgent.ts',
  ]

  test('all navigation-capable agent prompts include the shared contract', () => {
    for (const file of promptFiles) {
      const source = readFileSync(join(import.meta.dir, file), 'utf8')
      expect(source).toContain("import { MAP_ROUTING_GUIDANCE }")
      expect(source.match(/\$\{MAP_ROUTING_GUIDANCE\}/g)?.length).toBe(2)
    }
  })

  test('guidance preserves direct navigation and source authority', () => {
    expect(MAP_ROUTING_GUIDANCE).toContain('exact owner files or a focused map')
    expect(MAP_ROUTING_GUIDANCE).toContain('skip the workspace router')
    expect(MAP_ROUTING_GUIDANCE).toContain('source is authoritative')
  })
})
