import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

test('terminal and desktop reclaimers cannot both acquire consolidation', async () => {
  const memoryPath = await mkdtemp(join(tmpdir(), 'consolidation-lock-'))
  const childPath = join(import.meta.dir, 'consolidationLock.probe.child.ts')
  const startAt = String(Date.now() + 300)
  const children = ['terminal', 'desktop'].map(role =>
    Bun.spawn([process.execPath, childPath, role, memoryPath, startAt], {
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
  const recordedPids = children.map(child => child.pid)

  try {
    const exits = await Promise.race([
      Promise.all(children.map(child => child.exited)),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          for (const child of children) child.kill()
          reject(
            new Error(
              `timed out waiting for exact child PIDs ${recordedPids.join(', ')}`,
            ),
          )
        }, 10_000).unref()
      }),
    ])
    const [stdout, stderr] = await Promise.all([
      Promise.all(
        children.map(child => new Response(child.stdout).text()),
      ),
      Promise.all(
        children.map(child => new Response(child.stderr).text()),
      ),
    ])
    expect(exits, stderr.join('\n')).toEqual([0, 0])
    const results = stdout.map(value =>
      JSON.parse(value) as { role: string; pid: number; acquired: boolean },
    )
    expect(results.map(result => result.role).sort()).toEqual([
      'desktop',
      'terminal',
    ])
    expect(results.map(result => result.pid).sort()).toEqual(
      recordedPids.sort(),
    )
    expect(results.filter(result => result.acquired)).toHaveLength(1)

    const holderPid = Number(
      (await readFile(join(memoryPath, '.consolidate-lock'), 'utf8')).trim(),
    )
    expect(recordedPids).toContain(holderPid)
  } finally {
    await Promise.all(children.map(child => child.exited))
    await rm(memoryPath, { recursive: true, force: true })
  }
})
