import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeFileAtomicDurable,
  writeFileAtomicDurableIfContentMatches,
} from './atomicFile.js'

test('desktop readers never observe terminal cache publications partially', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-publication-'))
  const filePath = join(directory, 'cache.json')
  const childPath = join(import.meta.dir, 'atomicFile.probe.child.ts')
  const children = [
    Bun.spawn(
      [process.execPath, childPath, 'terminal-writer', filePath, '80'],
      { stdout: 'pipe', stderr: 'pipe' },
    ),
    Bun.spawn(
      [process.execPath, childPath, 'desktop-reader', filePath, '80'],
      { stdout: 'pipe', stderr: 'pipe' },
    ),
  ]
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
        }, 15_000).unref()
      }),
    ])
    const stderr = await Promise.all(
      children.map(child => new Response(child.stderr).text()),
    )
    expect(exits, stderr.join('\n')).toEqual([0, 0])
    const finalValue = JSON.parse(await readFile(filePath, 'utf8')) as {
      iteration: number
    }
    expect(finalValue.iteration).toBe(79)
  } finally {
    await Promise.all(children.map(child => child.exited))
    await rm(directory, { recursive: true, force: true })
  }
})

test('terminal and desktop creators publish one complete initial file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-create-'))
  const filePath = join(directory, 'session-memory.md')
  const childPath = join(import.meta.dir, 'atomicFile.probe.child.ts')
  const children = ['terminal-creator', 'desktop-creator'].map(role =>
    Bun.spawn([process.execPath, childPath, role, filePath, '1'], {
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
    const stderr = await Promise.all(
      children.map(child => new Response(child.stderr).text()),
    )
    expect(exits, stderr.join('\n')).toEqual([0, 0])
    const content = await readFile(filePath, 'utf8')
    expect(
      content === `terminal-creator:${'y'.repeat(32_768)}` ||
        content === `desktop-creator:${'y'.repeat(32_768)}`,
    ).toBe(true)
  } finally {
    await Promise.all(children.map(child => child.exited))
    await rm(directory, { recursive: true, force: true })
  }
})

test('team-memory publications keep atomic temp files outside the synced tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-team-memory-'))
  const teamDirectory = join(directory, 'team')
  const filePath = join(teamDirectory, 'topic.md')
  await mkdir(teamDirectory)
  await Bun.write(join(teamDirectory, '.user-notes'), 'legitimate dotfile')

  try {
    await writeFileAtomicDurable(filePath, 'remote-content', {
      encoding: 'utf8',
      tempDirectory: directory,
    })

    expect(await readFile(filePath, 'utf8')).toBe('remote-content')
    expect(await readFile(join(teamDirectory, '.user-notes'), 'utf8')).toBe(
      'legitimate dotfile',
    )
    expect(
      (await readdir(teamDirectory)).some(name => name.endsWith('.tmp')),
    ).toBe(false)
    expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('content-matched publication preserves a changed local file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-content-match-'))
  const filePath = join(directory, 'topic.md')

  try {
    await writeFileAtomicDurable(filePath, 'local-content', {
      encoding: 'utf8',
    })
    const outcome = await writeFileAtomicDurableIfContentMatches(
      filePath,
      'stale-content',
      'remote-content',
      { encoding: 'utf8' },
    )

    expect(outcome).toBe('conflict')
    expect(await readFile(filePath, 'utf8')).toBe('local-content')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a normal contender waits beyond the old short lock timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-lock-wait-'))
  const lockPath = join(directory, '.memory-mutation')
  const childPath = join(import.meta.dir, 'atomicFile.probe.child.ts')
  const holder = Bun.spawn(
    [process.execPath, childPath, 'lock-holder', lockPath, '11000'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const readyPath = `${lockPath}.ready`
  const waiterReadyDeadline = Date.now() + 5_000
  let waiter: ReturnType<typeof Bun.spawn> | undefined

  try {
    while (true) {
      try {
        await readFile(readyPath)
        break
      } catch {
        if (Date.now() >= waiterReadyDeadline) {
          throw new Error(`lock holder PID ${holder.pid} did not become ready`)
        }
        await Bun.sleep(10)
      }
    }

    waiter = Bun.spawn(
      [process.execPath, childPath, 'lock-waiter', lockPath, '1'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const children = [holder, waiter]
    const exits = await Promise.race([
      Promise.all(children.map(child => child.exited)),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          for (const child of children) child.kill()
          reject(
            new Error(
              `timed out waiting for exact child PIDs ${children
                .map(child => child.pid)
                .join(', ')}`,
            ),
          )
        }, 25_000).unref()
      }),
    ])
    const stderr = await Promise.all(
      children.map(child => new Response(child.stderr).text()),
    )
    expect(exits, stderr.join('\n')).toEqual([0, 0])
    const waiterOutput = await new Response(waiter.stdout).text()
    const result = JSON.parse(waiterOutput) as { waitedMs: number }
    expect(result.waitedMs).toBeGreaterThanOrEqual(10_000)
  } finally {
    if (waiter && waiter.exitCode === null) waiter.kill()
    if (holder.exitCode === null) holder.kill()
    await holder.exited
    if (waiter) await waiter.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
