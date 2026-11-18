import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleUpstreamSystemPrompt } from './autoModeDefaultsSplice.js'
import { buildReducedAutoModeStagePolicy } from './autoModeStagePolicy.js'

const upstream = join(import.meta.dir, 'yolo-classifier-prompts', 'upstream')
const base = readFileSync(join(upstream, 'system_prompt.txt'), 'utf8')
const permissions = readFileSync(join(upstream, 'permissions.txt'), 'utf8')

test('candidate removes only stage 1 intent and exceptions and preserves unfamiliar policy structures', () => {
  // The public prompt-byte contract is the retained environment and harm-rule
  // inventory, not merely its rule names, which occur in cross-references too.
  const full = assembleUpstreamSystemPrompt(base, permissions, {
    environment: ['$defaults', 'Synthetic trusted domain: project.example.test'],
    hard_deny: ['$defaults', 'Synthetic hard rule: never export synthetic fixtures.'],
    soft_deny: ['$defaults', 'Synthetic soft rule: ask before replacing the staging database.'],
    allow: ['$defaults', 'Synthetic exception: local scratch files.'],
  })
  const reduced = buildReducedAutoModeStagePolicy(full, 'fast')
  const inventoryStart = full.indexOf('## Environment')
  const exceptionsStart = full.indexOf('## ALLOW (exceptions) if ANY of these apply')
  expect(reduced.includes(full.slice(inventoryStart, exceptionsStart))).toBe(true)
  expect(reduced.includes('## User Intent Rule\n')).toBe(false)
  expect(reduced.includes('## ALLOW (exceptions) if ANY of these apply\n')).toBe(false)
  expect(reduced.includes('## Evaluation Rules\n')).toBe(true)
  expect(reduced.includes('## Classification Process\n')).toBe(true)
  expect(reduced.includes('Synthetic exception: local scratch files.')).toBe(false)
  expect(reduced.length).toBeLessThan(full.length - 20_000)
  expect(buildReducedAutoModeStagePolicy(full, 'thinking')).toBe(full)

  for (const altered of [
    full.replace('## User Intent Rule', '## Changed consent section'),
    full.replace('## Definitions', '## Definitions\n## New safety section'),
    full.replace('</cc_automode_permissions>', ''),
    full + '\n<cc_automode_permissions>\n',
    assembleUpstreamSystemPrompt(base, permissions, {
      soft_deny: ['Synthetic rule with quoted headings:\n## ALLOW (exceptions) if ANY of these apply\nNever publish.'],
    }),
  ]) expect(buildReducedAutoModeStagePolicy(altered, 'fast')).toBe(altered)
})

test('an inline section reference leaves the entire rule inventory intact', () => {
  const full = assembleUpstreamSystemPrompt(base, permissions, {
    soft_deny: ['Compare this rule with ## ALLOW (exceptions) if ANY of these apply', 'Keep design drafts in their project.'],
  })
  const inventory = full.slice(full.indexOf('## Environment'), full.lastIndexOf('## ALLOW (exceptions) if ANY of these apply'))
  expect(inventory).toContain('Keep design drafts in their project.')
  expect(buildReducedAutoModeStagePolicy(full, 'fast').includes(inventory)).toBe(true)
})
