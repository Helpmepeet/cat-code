import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function patch(path: string): string {
  return `*** Begin Patch\n*** Add File: ${path}\n+synthetic content\n*** End Patch`
}

function codexCall(id: string, input: string) {
  return [
    { type: 'response_item', timestamp: '2026-10-08T00:00:00.000Z', payload: { type: 'function_call', call_id: id, name: 'apply_patch', arguments: input } },
    { type: 'response_item', timestamp: '2026-10-08T00:00:01.000Z', payload: { type: 'function_call_output', call_id: id, output: 'Done' } },
  ]
}

function claudeCall(id: string, cwd: string, input: string) {
  return [
    { cwd, timestamp: '2026-10-08T00:00:00.000Z', type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'apply_patch', input: { patch: input } }] } },
    { cwd, timestamp: '2026-10-08T00:00:01.000Z', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Done' }] } },
  ]
}

test('edit ledger CLI retains relative and absolute repository patches from Codex and Claude only', () => {
  const root = mkdtempSync(join(tmpdir(), 'edit-ledger-cli-'))
  roots.push(root)
  const home = join(root, 'home')
  const repo = join(root, 'cat-code')
  mkdirSync(repo)
  const codexDir = join(home, '.codex', 'sessions')
  const claudeDir = join(home, '.claude', 'projects', 'synthetic')
  mkdirSync(codexDir, { recursive: true })
  mkdirSync(claudeDir, { recursive: true })

  const codexRecords = [
    { type: 'session_meta', payload: { cwd: repo } },
    ...codexCall('codex-relative', patch('src/relative.ts')),
    ...codexCall('codex-absolute', patch(join(repo, 'src', 'absolute.ts'))),
    ...codexCall('codex-outside', patch(join(root, 'outside.ts'))),
    { type: 'turn_context', payload: { cwd: join(root, 'external-worktree') } },
    ...codexCall('codex-outside-context', patch('src/outside-context.ts')),
    { type: 'turn_context', payload: { cwd: repo } },
    ...codexCall('codex-returned-to-repo', patch('src/returned-to-repo.ts')),
  ]
  writeFileSync(join(codexDir, 'synthetic.jsonl'), `${codexRecords.map(record => JSON.stringify(record)).join('\n')}\n`)
  const claudeRecords = [
    ...claudeCall('claude-relative', repo, patch('src/claude-relative.ts')),
    ...claudeCall('claude-absolute', repo, patch(join(repo, 'src', 'claude-absolute.ts'))),
    ...claudeCall('claude-outside', repo, patch(join(root, 'outside-claude.ts'))),
  ]
  writeFileSync(join(claudeDir, 'synthetic.jsonl'), `${claudeRecords.map(record => JSON.stringify(record)).join('\n')}\n`)

  const out = join(root, 'ledger.jsonl')
  const script = join(import.meta.dir, 'editLedger.ts')
  const result = spawnSync('bun', [script, out, '--repo', repo], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  expect(result.status).toBe(0)
  const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(rows).toHaveLength(5)
  expect(rows.every(row => row.ok === true)).toBe(true)
  expect(rows.map(row => `${row.src}:${row.paths[0]}`).sort()).toEqual([
    `claude:${join(repo, 'src', 'claude-absolute.ts')}`,
    `claude:${join(repo, 'src', 'claude-relative.ts')}`,
    `codex:${join(repo, 'src', 'absolute.ts')}`,
    `codex:${join(repo, 'src', 'relative.ts')}`,
    `codex:${join(repo, 'src', 'returned-to-repo.ts')}`,
  ])
})
