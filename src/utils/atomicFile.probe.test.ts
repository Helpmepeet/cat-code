import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireFileMutationLock,
  acquireFileMutationLocks,
  writeFileAtomicDurable,
  writeFileAtomicDurableIfContentMatches,
} from './atomicFile.js'

async function expectCrossProcessLockContention(
  waiterPath: string,
  directory: string,
  acquire: () => Promise<() => Promise<void>>,
): Promise<void> {
  const childPath = join(import.meta.dir, 'atomicFile.probe.child.ts')
  let release: (() => Promise<void>) | undefined
  let waiter: Bun.ReadableSubprocess | undefined

  try {
    release = await acquire()
    await Bun.write(`${waiterPath}.ready`, String(process.pid))
    waiter = Bun.spawn(
      [process.execPath, childPath, 'lock-waiter', waiterPath, '1'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await Bun.sleep(150)
    expect(waiter.exitCode).toBeNull()

    await release()
    release = undefined
    const exit = await waiter.exited
    const stderr = await new Response(waiter.stderr).text()
    expect(exit, stderr).toBe(0)
    const result = JSON.parse(await new Response(waiter.stdout).text()) as {
      waitedMs: number
    }
    expect(result.waitedMs).toBeGreaterThanOrEqual(100)
  } finally {
    await release?.().catch(() => {})
    if (waiter?.exitCode === null) waiter.kill()
    if (waiter) await waiter.exited
    await rm(directory, { recursive: true, force: true })
  }
}

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
  let waiter: Bun.ReadableSubprocess | undefined

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

test('file mutation locks serialize target and symlink paths across processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-alias-lock-'))
  const targetPath = join(directory, 'target.json')
  const aliasPath = join(directory, 'alias.json')
  const childPath = join(import.meta.dir, 'atomicFile.probe.child.ts')
  await Bun.write(targetPath, JSON.stringify({ edits: [] }))
  await symlink(targetPath, aliasPath)

  const first = Bun.spawn(
    [
      process.execPath,
      childPath,
      'alias-editor',
      targetPath,
      '1',
      targetPath,
      directory,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  let second: Bun.ReadableSubprocess | undefined

  try {
    const readyDeadline = Date.now() + 5_000
    while (!(await Bun.file(join(directory, 'entered-1')).exists())) {
      if (Date.now() >= readyDeadline) {
        throw new Error(`alias editor PID ${first.pid} did not become ready`)
      }
      await Bun.sleep(5)
    }

    second = Bun.spawn(
      [
        process.execPath,
        childPath,
        'alias-editor',
        aliasPath,
        '2',
        targetPath,
        directory,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const children = [first, second]
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
        }, 10_000).unref()
      }),
    ])
    const stderr = await Promise.all(
      children.map(child => new Response(child.stderr).text()),
    )
    expect(exits, stderr.join('\n')).toEqual([0, 0])
    expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({
      edits: [1, 2],
    })
  } finally {
    if (second && second.exitCode === null) second.kill()
    if (first.exitCode === null) first.kill()
    await first.exited
    if (second) await second.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test('multi-file mutation locks deduplicate aliases and release for another process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-multi-alias-lock-'))
  const targetPath = join(directory, 'target.json')
  const aliasPath = join(directory, 'alias.json')
  await Bun.write(targetPath, '{}')
  await symlink(targetPath, aliasPath)

  await expectCrossProcessLockContention(aliasPath, directory, () =>
    Promise.race([
      acquireFileMutationLocks([targetPath, aliasPath, targetPath]),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('multi-file alias acquisition deadlocked')),
          2_000,
        ).unref()
      }),
    ]),
  )
}, 10_000)

test('new-file mutation locks contend through linked directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-linked-directory-'))
  const targetDirectory = join(directory, 'target')
  const aliasDirectory = join(directory, 'alias')
  const targetPath = join(targetDirectory, 'new.json')
  const aliasPath = join(aliasDirectory, 'new.json')
  await mkdir(targetDirectory)
  await symlink(targetDirectory, aliasDirectory)

  await expectCrossProcessLockContention(aliasPath, directory, () =>
    acquireFileMutationLock(targetPath),
  )
}, 10_000)

test('dangling symlink mutation locks contend with their missing targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-dangling-alias-'))
  const targetDirectory = join(directory, 'targets')
  await mkdir(join(targetDirectory, 'nested'), { recursive: true })
  await symlink('targets/nested', join(directory, 'directory-link'))
  const targetPath = join(targetDirectory, 'target.json')
  const aliasPath = join(directory, 'alias.json')
  await symlink('directory-link/../target.json', aliasPath)

  await expectCrossProcessLockContention(aliasPath, directory, () =>
    acquireFileMutationLock(targetPath),
  )
}, 10_000)

test('FileEdit waits on a target lock when called through a symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-file-edit-alias-'))
  const targetPath = join(directory, 'target.txt')
  const aliasPath = join(directory, 'alias.txt')
  const childPath = join(import.meta.dir, 'atomicFile.probe.child.ts')
  await Bun.write(targetPath, 'before\n')
  await symlink(targetPath, aliasPath)

  let release: (() => Promise<void>) | undefined
  let editor: Bun.ReadableSubprocess | undefined
  try {
    release = await acquireFileMutationLock(targetPath)
    editor = Bun.spawn(
      [
        process.execPath,
        childPath,
        'file-edit',
        aliasPath,
        '1',
        'before',
        'after',
        directory,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CLAUDE_CODE_SIMPLE: '1' },
      },
    )
    const readyDeadline = Date.now() + 5_000
    while (!(await Bun.file(join(directory, 'file-edit-started')).exists())) {
      if (Date.now() >= readyDeadline) {
        throw new Error(`FileEdit probe PID ${editor.pid} did not become ready`)
      }
      await Bun.sleep(5)
    }
    await Bun.sleep(500)
    expect(editor.exitCode).toBeNull()

    await release()
    release = undefined
    const exit = await editor.exited
    const stderr = await new Response(editor.stderr).text()
    expect(exit, stderr).toBe(0)
    expect(await readFile(targetPath, 'utf8')).toBe('after\n')
  } finally {
    await release?.().catch(() => {})
    if (editor?.exitCode === null) editor.kill()
    if (editor) await editor.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
