import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifySearch, runMapRoutingNudge } from './mapRoutingNudge.js'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'map-nudge-test-'))
  roots.push(root)
  const repoRoot = join(root, 'repo')
  const stateRoot = join(root, 'state')
  mkdirSync(join(repoRoot, 'src'), { recursive: true })
  mkdirSync(stateRoot)
  writeFileSync(join(repoRoot, 'src', 'owner.ts'), 'export {}\n')
  const transcriptPath = join(root, 'session.jsonl')
  writeFileSync(transcriptPath, '{"type":"tool_use","name":"Read","input":{"file_path":"CLAUDE.md"}}\n')
  return { repoRoot, stateRoot, transcriptPath }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('map routing nudge classification', () => {
  test('classifies repo-wide Grep and Glob calls as broad', () => {
    const { repoRoot } = fixture()
    expect(classifySearch({ tool_name: 'Grep', tool_input: { pattern: 'owner' } }, repoRoot)).toBe('broad')
    expect(classifySearch({ tool_name: 'Glob', tool_input: { pattern: 'src/**/*.ts' } }, repoRoot)).toBe('broad')
  })

  test('keeps exact owner-file and external searches out of scope', () => {
    const { repoRoot } = fixture()
    expect(classifySearch({ tool_name: 'Grep', tool_input: { path: 'src/owner.ts', pattern: 'owner' } }, repoRoot)).toBe('narrow')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: 'rg owner src/owner.ts' } }, repoRoot)).toBe('narrow')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: "rg 'owner[0-9]' src/owner.ts" } }, repoRoot)).toBe('narrow')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: "rg 'src/[ab]' src/owner.ts" } }, repoRoot)).toBe('narrow')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: "rg 'https?://[ab]' src/owner.ts" } }, repoRoot)).toBe('narrow')
    expect(classifySearch({ tool_name: 'Grep', tool_input: { path: tmpdir(), pattern: 'owner' } }, repoRoot)).toBe('external')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: `cd ${tmpdir()} && rg owner .` } }, repoRoot)).toBe('external')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: 'cd ~ && rg owner .' } }, repoRoot)).toBe('external')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: 'rg owner ~/Documents' } }, repoRoot)).toBe('external')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: 'rg owner /tmp/*.md' } }, repoRoot)).toBe('external')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: 'rg owner ~/Documents/*.md' } }, repoRoot)).toBe('external')
    expect(classifySearch({ tool_name: 'Bash', tool_input: { command: 'git status --short | grep docs' } }, repoRoot)).toBe('not-search')
  })
})

describe('map routing nudge lifecycle', () => {
  test('fires on the first broad search and only once', () => {
    const options = fixture()
    const input = {
      session_id: 'session-one',
      tool_name: 'Grep',
      tool_input: { pattern: 'owner' },
      transcript_path: options.transcriptPath,
    }
    const first = runMapRoutingNudge(input, { ...options, logFile: false })
    expect(first).toContain('docs/maps/WORKSPACE_MAP.md')
    expect(first).not.toContain('permissionDecision')
    expect(runMapRoutingNudge(input, { ...options, logFile: false })).toBeNull()
  })

  test('a narrow search does not consume the later broad-search nudge', () => {
    const options = fixture()
    const shared = { session_id: 'session-two', transcript_path: options.transcriptPath }
    expect(runMapRoutingNudge({ ...shared, tool_name: 'Grep', tool_input: { path: 'src/owner.ts', pattern: 'owner' } }, { ...options, logFile: false })).toBeNull()
    expect(runMapRoutingNudge({ ...shared, tool_name: 'Grep', tool_input: { pattern: 'owner' } }, { ...options, logFile: false })).toContain('WORKSPACE_MAP.md')
  })

  test('a prior focused-map read suppresses the nudge', () => {
    const options = fixture()
    writeFileSync(options.transcriptPath, '{"type":"tool_use","name":"Read","input":{"file_path":"docs/maps/prompt-system.md"}}\n')
    const output = runMapRoutingNudge({
      session_id: 'session-three',
      tool_name: 'Glob',
      tool_input: { pattern: '**/*.ts' },
      transcript_path: options.transcriptPath,
    }, { ...options, logFile: false })
    expect(output).toBeNull()
  })

  test('listing map names does not count as consulting a map', () => {
    const options = fixture()
    writeFileSync(options.transcriptPath, '{"type":"tool_use","name":"Glob","input":{"pattern":"docs/maps/*.md"}}\n')
    const output = runMapRoutingNudge({
      session_id: 'session-four',
      tool_name: 'Grep',
      tool_input: { pattern: 'owner' },
      transcript_path: options.transcriptPath,
    }, { ...options, logFile: false })
    expect(output).toContain('WORKSPACE_MAP.md')
  })
})
