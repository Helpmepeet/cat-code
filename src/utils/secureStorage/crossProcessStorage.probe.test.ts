import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createCrossProcessSafeStorage } from './crossProcessStorage.js'

const roots: string[] = []
const CHILD = join(import.meta.dir, 'crossProcessStorage.probe.child.ts')

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function waitFor(path: string, pid: number): Promise<void> {
  const startedAt = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - startedAt > 30_000) {
      throw new Error(`secure-storage child PID ${pid} did not become ready`)
    }
    await Bun.sleep(10)
  }
  expect(Number(readFileSync(path, 'utf8'))).toBe(pid)
}

describe('secure storage cross-process updates', () => {
  test('refuses to publish when the fresh store read is unavailable', () => {
    const writes: Record<string, unknown>[] = []
    const storage = createCrossProcessSafeStorage({
      name: 'synthetic',
      read: () => ({ preserved: 'credential' }),
      readAsync: async () => ({ preserved: 'credential' }),
      readFresh: () => ({ status: 'unavailable', data: null }),
      update: data => {
        writes.push(data)
        return { success: true }
      },
      delete: () => true,
    })

    const snapshot = storage.read()!
    delete snapshot.preserved
    snapshot.changed = true
    storage.read()

    expect(storage.update(snapshot).success).toBe(false)
    expect(writes).toEqual([])
  })

  test('keeps the first read base when a cached object is read again', () => {
    const writes: Record<string, unknown>[] = []
    const cached = { first: 'value', untouched: 'credential' }
    const storage = createCrossProcessSafeStorage({
      name: 'synthetic',
      read: () => cached,
      readAsync: async () => cached,
      readFresh: () => ({ status: 'present', data: { ...cached } }),
      update: data => {
        writes.push(data)
        return { success: true }
      },
      delete: () => true,
    })

    const firstRead = storage.read()!
    delete firstRead.first
    storage.read()
    expect(storage.update(firstRead).success).toBe(true)
    expect(writes).toEqual([{ untouched: 'credential' }])
  })

  test('terminal and desktop preserve independent fields from stale snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'secure-storage-contention-'))
    roots.push(root)
    const configHome = join(root, 'config')
    const startFile = join(root, 'start')
    const roles = ['terminal', 'desktop'] as const
    const children = roles.map(role => {
      const readyFile = join(root, `${role}.ready`)
      const child = Bun.spawn([process.execPath, 'run', CHILD], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          CLAUDE_CONFIG_DIR: configHome,
          NODE_ENV: 'development',
          PROBE_ROLE: role,
          PROBE_READY_FILE: readyFile,
          PROBE_START_FILE: startFile,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return { role, readyFile, child, pid: child.pid }
    })

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.all(children.map(({ readyFile, pid }) => waitFor(readyFile, pid)))
      writeFileSync(startFile, 'start')
      const exits = await Promise.race([
        Promise.all(children.map(({ child }) => child.exited)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            for (const { child } of children) child.kill()
            reject(
              new Error(
                `secure-storage children timed out: ${children.map(({ pid }) => pid).join(',')}`,
              ),
            )
          }, 30_000)
        }),
      ])
      const outputs = await Promise.all(
        children.map(async ({ role, child, pid }, index) => ({
          role,
          pid,
          exitCode: exits[index],
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        })),
      )
      expect(outputs.map(({ exitCode }) => exitCode)).toEqual([0, 0])
      for (const output of outputs) {
        const line = output.stdout
          .split('\n')
          .find(value => value.startsWith('RESULT:'))
        expect(line, output.stderr).toBeDefined()
        expect(JSON.parse(line!.slice('RESULT:'.length))).toMatchObject({
          role: output.role,
          pid: output.pid,
          success: true,
        })
      }

      const stored = JSON.parse(
        readFileSync(join(configHome, '.credentials.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(stored).toMatchObject({
        claudeAiOauth: {
          accessToken: 'synthetic-terminal-access',
        },
        mcpOAuth: {
          'synthetic-server': {
            accessToken: 'synthetic-desktop-access',
          },
        },
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      await Promise.all(children.map(({ child }) => child.exited))
    }
  })
})
