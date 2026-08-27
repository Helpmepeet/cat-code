import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'fs'
import { join } from 'path'
import { enableConfigs, getGlobalConfig } from '../utils/config.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import * as lockfile from '../utils/lockfile.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { runEngineMigrations } from './runEngineMigrations.js'

const role = process.env.MIGRATION_PROBE_ROLE
const probeRoot = process.env.MIGRATION_PROBE_ROOT
if (
  (role !== 'init-owner' &&
    role !== 'migration-contender' &&
    role !== 'crash-owner') ||
  !probeRoot
) {
  throw new Error('Migration probe role and root are required')
}

if (role === 'crash-owner') {
  const configHome = getClaudeConfigHomeDir()
  mkdirSync(configHome, { recursive: true, mode: 0o700 })
  const lockTarget = join(configHome, '.engine-migrations')
  const descriptor = openSync(lockTarget, 'a', 0o600)
  closeSync(descriptor)
  await lockfile.lock(lockTarget, {
    lockfilePath: `${lockTarget}.lock`,
    realpath: false,
    retries: 0,
    stale: 5_000,
    update: 1_000,
  })
  writeFileSync(join(probeRoot, 'ready-crash-owner'), String(process.pid))
  while (true) {
    await Bun.sleep(5)
  }
}

enableConfigs()
const cachedMigrationVersionBefore = getGlobalConfig().migrationVersion
writeFileSync(join(probeRoot, `ready-${role}`), String(process.pid))
while (!existsSync(join(probeRoot, 'start'))) {
  await Bun.sleep(5)
}

if (role === 'migration-contender') {
  const { error } = updateSettingsForSource('userSettings', current => ({
    ...(current ?? {}),
    env: {
      ...current?.env,
      CONTENDER_ROLE: role,
    },
  }))
  if (error) throw error
}

await runEngineMigrations()
process.stdout.write(
  `${JSON.stringify({
    role,
    pid: process.pid,
    cachedMigrationVersionBefore,
  })}\n`,
)
