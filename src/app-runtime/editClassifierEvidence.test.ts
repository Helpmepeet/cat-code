import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIDECAR_RUNTIME_ARGS } from '../../app/main/mainDecisions.js'

test('Auto reviews complete Edit removals, additions and replace-all for pending and completed calls', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'edit-classifier-evidence-')))
  try {
    await Promise.all(['config', 'workspace', 'reports'].map(name => mkdir(join(root, name))))
    const oldString = 'REMOVED_GUARD_BEGIN\n' + 'Require exact production approval.\n'.repeat(240) + 'REMOVED_GUARD_END'
    const edits = [
      { file_path: join(root, 'reports', 'multiple.cjs'), old_string: oldString, new_string: 'ADDED_PREVIEW_ONLY', replace_all: true },
      { file_path: join(root, 'reports', 'single.cjs'), old_string: 'SINGLE_REMOVED_GUARD', new_string: 'SINGLE_ADDED_PREVIEW' },
    ]
    const child = Bun.spawn([process.execPath, ...SIDECAR_RUNTIME_ARGS, new URL('./editClassifierEvidence.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-5',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        EDIT_EVIDENCE_TEST_ROOT: root, EDIT_EVIDENCE_TEST_INPUT: JSON.stringify(edits) },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Edit evidence fixture failed (${code}): ${stderr}\n${stdout}`)
    const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
    expect(evidence.permissions).toEqual([])
    expect(evidence.contents).toEqual(['ADDED_PREVIEW_ONLY\nADDED_PREVIEW_ONLY\n', 'SINGLE_ADDED_PREVIEW\n'])
    expect(evidence.receipt).toBe('EVIDENCE_RECEIPT_PENDING')
    const reviews = evidence.classifierBodies.map((body: any) => ({ maxTokens: body.max_tokens,
      records: body.messages.flatMap((message: any) => (typeof message.content === 'string' ? [message.content] :
        message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text))
        .flatMap((text: string) => text.split('\n').flatMap(line => {
          const match = line.match(/^(Edit|Write)(?:\[[^\]]*\])? (.*)$/)
          if (!match) return []
          const value = match[2]!
          return [{ [match[1]!]: /^[{"]/.test(value) ? JSON.parse(value) : value }]
        }))) }))
    expect(reviews.length).toBeGreaterThanOrEqual(6)
    for (const input of edits) {
      const pending = reviews.filter((review: any) => {
        const projection = review.records.at(-1)?.Edit
        return typeof projection === 'string' ? projection.includes(input.file_path) : projection?.file_path === input.file_path
      })
      expect(pending.map((review: any) => review.maxTokens)).toEqual([64, 4096])
      for (const review of pending) {
        const projection = review.records.at(-1).Edit
        expect(projection.removes === input.old_string).toBe(true)
        expect(projection.adds).toBe(input.new_string)
        expect(projection.replaceAll).toBe(input.replace_all ?? false)
      }
    }
    const receiptReviews = reviews.filter((review: any) => review.records.at(-1)?.Write?.includes('EVIDENCE_RECEIPT_PENDING'))
    expect(receiptReviews).toHaveLength(2)
    for (const review of receiptReviews) for (const input of edits) {
      const historical = review.records.find((record: any) => record.Edit?.file_path === input.file_path)?.Edit
      expect(historical?.removes === input.old_string).toBe(true)
      expect(historical?.adds).toBe(input.new_string)
      expect(historical?.replaceAll).toBe(input.replace_all ?? false)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
