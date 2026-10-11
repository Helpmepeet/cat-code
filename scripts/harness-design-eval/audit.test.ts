import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audit } from './audit.js'

test('audit counts records without counting thresholds as compactions or disclosing bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-audit-'))
  try {
    const debug = join(root, 'debug'), projects = join(root, 'projects')
    await mkdir(debug); await mkdir(projects)
    const session = '12345678-1234-1234-1234-123456789abc'
    const timestamp = '2026-10-11T00:00:00.000Z'
    const usage = `${timestamp} [DEBUG] [codex-cache] owner=main-thread account=secret-account model=gpt-6.1-sol key=secret-key conversation=secret-conversation cached=90 input=100`
    await writeFile(join(debug, `${session}.txt`), [
      `${timestamp} [DEBUG] autocompact: tokens=10 threshold=100 effectiveWindow=200 nonMessageOverhead=2`,
      usage, usage,
      `${timestamp} [DEBUG] [codex-ws] full send input=2 items`,
      `${timestamp} [DEBUG] Bash echo compact secret-body`,
    ].join('\n'))
    await symlink(join(debug, `${session}.txt`), join(debug, 'duplicate.txt'))
    await writeFile(join(projects, `${session}.jsonl`), JSON.stringify({ type: 'system', subtype: 'compact_boundary',
      sessionId: session, uuid: 'boundary', timestamp, compactMetadata: { trigger: 'manual' } }) + '\n')
    const result = await audit(debug, projects)
    expect(result.totals.logs).toBe(1)
    expect(result.totals.thresholdChecks).toBe(1)
    expect(result.totals.checksAtThreshold).toBe(0)
    expect(result.totals.persistedBoundaries).toBe(1)
    expect(result.cache).toMatchObject({ responses: 1, input: 100, cached: 90 })
    expect(result.sendModes).toEqual({ full: 1 })
    expect(result.boundaries[0]?.composition.available).toBe(false)
    const output = JSON.stringify(result)
    for (const secret of [session, 'secret-account', 'secret-key', 'secret-conversation', 'secret-body', root]) expect(output).not.toContain(secret)
    // A filename alone never proves a transcript's session identity.
    await writeFile(join(projects, `${session}.jsonl`), JSON.stringify({ sessionId: 'different', type: 'system', subtype: 'compact_boundary' }))
    expect((await audit(debug, projects)).totals.persistedBoundaries).toBe(0)
    // A fully paired, linear fixture supports a post-cap character proxy.
    const rows: Record<string, unknown>[] = []
    let parent: string | null = null
    for (let i = 0; i < 5; i++) {
      const call = `call-${i}`, a = `assistant-${i}`, u = `result-${i}`
      rows.push({ sessionId: session, uuid: a, parentUuid: parent, timestamp, type: 'assistant',
        message: { id: a, content: [{ type: 'tool_use', id: call, name: 'Bash' }] } })
      rows.push({ sessionId: session, uuid: u, parentUuid: a, timestamp, type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: call, content: 'x'.repeat(i === 0 ? 100_000 : i === 1 ? 40_000 : 8) }] } })
      parent = u
    }
    rows.push({ sessionId: session, uuid: 'boundary', logicalParentUuid: parent, timestamp, type: 'system', subtype: 'compact_boundary' })
    await writeFile(join(projects, `${session}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n'))
    const composition = (await audit(debug, projects)).boundaries[0]!.composition
    expect(composition).toMatchObject({ available: true, rawChars: 140024, postCapChars: 88024, eligibleOldChars: 88000, protectedChars: 24 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
