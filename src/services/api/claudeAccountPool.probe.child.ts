import { readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { writeFileAtomicDurable } from '../../utils/atomicFile.js'
import { lock } from '../../utils/lockfile.js'
import {
  deleteClaudeVaultFile,
  seedClaudeAccountPoolForTest,
  setClaudeAccountAlias,
  setClaudeVaultPathForTest,
  updateClaudeAccountTokens,
} from './claudeAccountPool.js'

const [role, action, vaultPath, readyPath] = process.argv.slice(2)
if (!role || !action || !vaultPath || !readyPath) {
  throw new Error('expected role, action, vault path, and ready path')
}

if (role === 'terminal-holder') {
  const release = await lock(vaultPath, {
    realpath: false,
    stale: 120_000,
    update: 30_000,
  })
  try {
    await writeFile(readyPath, String(process.pid), 'utf8')
    await Bun.sleep(250)
    if (action !== 'delete') {
      const value = JSON.parse(await readFile(vaultPath, 'utf8')) as Record<
        string,
        unknown
      >
      value.terminal_marker = action
      await writeFileAtomicDurable(
        vaultPath,
        `${JSON.stringify(value, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }
  } finally {
    await release()
  }
} else if (role === 'desktop-mutator') {
  for (;;) {
    try {
      await readFile(readyPath)
      break
    } catch {
      await Bun.sleep(5)
    }
  }

  if (action === 'delete') {
    if (!deleteClaudeVaultFile(vaultPath)) {
      throw new Error('desktop delete failed')
    }
  } else {
    const accountUuid = 'synthetic-account'
    setClaudeVaultPathForTest(dirname(dirname(vaultPath)))
    seedClaudeAccountPoolForTest({
      activeAccountUuid: accountUuid,
      accounts: [
        {
          accountUuid,
          emailAddress: 'synthetic@example.com',
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() + 60_000,
          status: 'healthy',
          vaultFilePath: vaultPath,
        },
      ],
    })
    if (action === 'save') {
      updateClaudeAccountTokens(accountUuid, {
        accessToken: 'desktop-access',
        refreshToken: 'desktop-refresh',
      })
    } else if (action === 'alias') {
      if (!setClaudeAccountAlias(accountUuid, 'desktop-alias')) {
        throw new Error('desktop alias failed')
      }
    } else {
      throw new Error(`unknown action: ${action}`)
    }
  }
} else {
  throw new Error(`unknown role: ${role}`)
}

process.stdout.write(JSON.stringify({ role, action, pid: process.pid }))
