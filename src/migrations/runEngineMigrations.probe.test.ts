import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const probeRoots: string[] = []

afterEach(() => {
  for (const root of probeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function waitForReady(root: string, roles: string[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (roles.some(role => !existsSync(join(root, `ready-${role}`)))) {
    if (Date.now() >= deadline) throw new Error('Migration contenders did not become ready')
    await Bun.sleep(10)
  }
}

describe('runEngineMigrations process ownership', () => {
  test('reports a non-object global config as ConfigParseError', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-code-engine-migrations-invalid-'))
    probeRoots.push(root)
    const configHome = join(root, 'config')
    mkdirSync(configHome, { recursive: true })
    writeFileSync(join(configHome, '.cat-code.json'), 'null')

    const childPath = fileURLToPath(
      new URL('./runEngineMigrations.probe.child.ts', import.meta.url),
    )
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete childEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL
    delete childEnv.USE_LOCAL_OAUTH
    delete childEnv.USE_STAGING_OAUTH
    delete childEnv.USER_TYPE
    childEnv.CLAUDE_CONFIG_DIR = configHome
    childEnv.MIGRATION_PROBE_ROOT = root
    childEnv.NODE_ENV = 'production'

    const child = Bun.spawn([process.execPath, childPath], {
      cwd: root,
      env: { ...childEnv, MIGRATION_PROBE_ROLE: 'init-owner' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const pid = child.pid
    try {
      await waitForReady(root, ['init-owner'])
      writeFileSync(join(root, 'start'), String(pid))
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain('ConfigParseError')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
  })

  test('reclaims a crash-stale migration lock in a separate process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-code-engine-migrations-stale-'))
    probeRoots.push(root)
    const configHome = join(root, 'config')
    mkdirSync(configHome, { recursive: true })
    writeFileSync(
      join(configHome, '.cat-code.json'),
      JSON.stringify({ migrationVersion: 14, unrelatedGlobal: 'keep-global' }),
    )

    const childPath = fileURLToPath(
      new URL('./runEngineMigrations.probe.child.ts', import.meta.url),
    )
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete childEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL
    delete childEnv.USE_LOCAL_OAUTH
    delete childEnv.USE_STAGING_OAUTH
    delete childEnv.USER_TYPE
    childEnv.CLAUDE_CONFIG_DIR = configHome
    childEnv.MIGRATION_PROBE_ROOT = root
    childEnv.NODE_ENV = 'production'

    const owner = Bun.spawn([process.execPath, childPath], {
      cwd: root,
      env: { ...childEnv, MIGRATION_PROBE_ROLE: 'crash-owner' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const ownerPid = owner.pid
    try {
      await waitForReady(root, ['crash-owner'])
      owner.kill('SIGKILL')
      expect(await owner.exited).not.toBe(0)
      expect(existsSync(join(configHome, '.engine-migrations.lock'))).toBe(true)

      const contender = Bun.spawn([process.execPath, childPath], {
        cwd: root,
        env: { ...childEnv, MIGRATION_PROBE_ROLE: 'init-owner' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const contenderPid = contender.pid
      await waitForReady(root, ['init-owner'])
      const startedAt = Date.now()
      writeFileSync(join(root, 'start'), String(contenderPid))
      let contenderStderr = ''
      const timeout = setTimeout(() => {
        if (contender.exitCode === null) contender.kill('SIGKILL')
      }, 15_000)
      try {
        const contenderExit = await contender.exited
        contenderStderr = await new Response(contender.stderr).text()
        expect(contenderExit, contenderStderr).toBe(0)
      } finally {
        clearTimeout(timeout)
      }
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_500)
      expect(contenderStderr).toBe('')
      expect(JSON.parse(await new Response(contender.stdout).text())).toMatchObject({
        role: 'init-owner',
        pid: contenderPid,
        cachedMigrationVersionBefore: 14,
      })
      expect(
        JSON.parse(readFileSync(join(configHome, '.cat-code.json'), 'utf8'))
          .migrationVersion,
      ).toBe(15)
    } finally {
      if (owner.exitCode === null) owner.kill('SIGKILL')
      await owner.exited
    }
  }, 25_000)

  test('two cached contenders serialize migration state and preserve unrelated settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-code-engine-migrations-'))
    probeRoots.push(root)
    const configHome = join(root, 'config')
    const workspace = join(root, 'workspace')
    mkdirSync(configHome, { recursive: true })
    mkdirSync(join(workspace, '.cat-code'), { recursive: true })
    const canonicalWorkspace = realpathSync(workspace)

    writeFileSync(
      join(configHome, '.cat-code.json'),
      JSON.stringify({
        migrationVersion: 14,
        autoUpdates: false,
        unrelatedGlobal: 'keep-global',
        projects: {
          [canonicalWorkspace]: {
            hasTrustDialogAccepted: true,
            enableAllProjectMcpServers: true,
            enabledMcpjsonServers: ['project-server'],
            disabledMcpjsonServers: ['blocked-server'],
          },
        },
      }),
    )
    writeFileSync(
      join(configHome, 'settings.json'),
      JSON.stringify({
        model: 'gpt-5.4',
        availableModels: ['gpt-5.4', 'custom-model'],
        modelOverrides: {
          'gpt-5.4': 'legacy-override',
          'custom-model': 'keep-override',
        },
        env: { UNRELATED_ENV: 'keep-user' },
      }),
    )
    writeFileSync(
      join(workspace, '.cat-code', 'settings.local.json'),
      JSON.stringify({
        enabledMcpjsonServers: ['existing-server'],
        permissions: { allow: ['Read'] },
      }),
    )

    const childPath = fileURLToPath(
      new URL('./runEngineMigrations.probe.child.ts', import.meta.url),
    )
    const roles = ['init-owner', 'migration-contender'] as const
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete childEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL
    delete childEnv.USE_LOCAL_OAUTH
    delete childEnv.USE_STAGING_OAUTH
    delete childEnv.USER_TYPE
    childEnv.CLAUDE_CONFIG_DIR = configHome
    childEnv.MIGRATION_PROBE_ROOT = root
    childEnv.NODE_ENV = 'production'

    const children = roles.map(role => {
      const child = Bun.spawn([process.execPath, childPath], {
        cwd: canonicalWorkspace,
        env: { ...childEnv, MIGRATION_PROBE_ROLE: role },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return { role, child, pid: child.pid }
    })
    const spawnedPids = children.map(({ pid }) => pid)

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await waitForReady(root, roles)
      writeFileSync(join(root, 'start'), spawnedPids.join(','))

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Migration contenders timed out: ${spawnedPids.join(',')}`)),
          10_000,
        )
      })
      await Promise.race([
        Promise.all(children.map(({ child }) => child.exited)),
        timeoutPromise,
      ])
    } catch (error) {
      for (const { child, pid } of children) {
        if (child.exitCode === null && spawnedPids.includes(pid)) {
          child.kill('SIGKILL')
        }
      }
      await Promise.all(children.map(({ child }) => child.exited))
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    const results = await Promise.all(
      children.map(async ({ role, child, pid }) => ({
        role,
        pid,
        exitCode: child.exitCode,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    )
    expect(results).toEqual(
      results.map(result => ({ ...result, exitCode: 0, stderr: '' })),
    )
    const childResults = results.map(result => JSON.parse(result.stdout))
    expect(
      childResults.map(result => ({ role: result.role, pid: result.pid })),
    ).toEqual(results.map(({ role, pid }) => ({ role, pid })))
    expect(
      childResults.map(result => result.cachedMigrationVersionBefore),
    ).toEqual([14, 14])
    expect(new Set(spawnedPids).size).toBe(2)

    const globalConfig = JSON.parse(
      readFileSync(join(configHome, '.cat-code.json'), 'utf8'),
    )
    expect(globalConfig.migrationVersion).toBe(15)
    expect(globalConfig.unrelatedGlobal).toBe('keep-global')
    expect(globalConfig.autoUpdates).toBeUndefined()
    expect(globalConfig.projects[canonicalWorkspace]).toEqual({
      hasTrustDialogAccepted: true,
    })

    const userSettings = JSON.parse(
      readFileSync(join(configHome, 'settings.json'), 'utf8'),
    )
    expect(userSettings).toMatchObject({
      model: 'gpt-5.6-luna',
      availableModels: ['gpt-5.6-luna', 'custom-model'],
      modelOverrides: {
        'gpt-5.6-luna': 'legacy-override',
        'custom-model': 'keep-override',
      },
      env: {
        UNRELATED_ENV: 'keep-user',
        CONTENDER_ROLE: 'migration-contender',
        DISABLE_AUTOUPDATER: '1',
      },
    })

    const localSettings = JSON.parse(
      readFileSync(join(workspace, '.cat-code', 'settings.local.json'), 'utf8'),
    )
    expect(localSettings).toEqual({
      enabledMcpjsonServers: ['existing-server', 'project-server'],
      permissions: { allow: ['Read'] },
      enableAllProjectMcpServers: true,
      disabledMcpjsonServers: ['blocked-server'],
    })
  }, 20_000)
})
