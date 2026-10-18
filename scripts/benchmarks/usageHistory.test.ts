import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('each benchmark step resets its sampled RSS peak', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-benchmark-test-'))
  try {
    const preload = join(root, 'rss.ts'), home = join(root, 'home')
    await mkdir(home)
    // A synthetic cold-step high-water mark must not carry into warm steps.
    await writeFile(preload, `
      const original = process.memoryUsage.bind(process);
      let reads = 0;
      process.memoryUsage = Object.assign(() => ({
        ...original(), rss: (++reads === 1 ? 900 : 100) * 1048576,
      }), { rss: () => 100 * 1048576 });
    `)
    const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, 'usageHistory.ts'), '--case', 'cold', '--sources', '1', '--requests', '2'], {
      env: { HOME: home, CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_HOME: join(home, 'codex') },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    const rows = stdout.split('\n').filter(line => line.startsWith('BENCH ')).map(line => JSON.parse(line.slice(6)))
    expect(rows.map(row => [row.step, row.ok, row.peakRssMiBSampled])).toEqual([
      ['cold-rebuild', true, 900],
      ['unchanged-same-day', true, 100],
      ['append-one-record', true, 100],
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
