import { readFile, writeFile } from 'fs/promises'
import { writeFileAtomicDurable } from '../../utils/atomicFile.js'
import {
  deleteCodexVaultFile,
  saveCodexTokenToVault,
  seedCodexAccountPoolForTest,
  setAccountAlias,
} from './codexAccountPool.js'
import { acquireCodexVaultFileLock } from './codexTokenRefresh.js'

const [role, action, vaultPath, readyPath] = process.argv.slice(2)
if (!role || !action || !vaultPath || !readyPath) {
  throw new Error('expected role, action, vault path, and ready path')
}

if (role === 'terminal-holder') {
  const release = await acquireCodexVaultFileLock(vaultPath, error => {
    throw error
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

  if (action === 'save') {
    const saved = saveCodexTokenToVault(
      {
        accessToken: 'desktop-access',
        refreshToken: 'desktop-refresh',
        accountId: 'synthetic-account',
      },
      { filePath: vaultPath },
    )
    if (!saved) throw new Error('desktop save failed')
  } else if (action === 'alias') {
    seedCodexAccountPoolForTest({
      activeAccountId: 'synthetic-account',
      accounts: [
        {
          accountId: 'synthetic-account',
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() + 60_000,
          source: 'vault',
          status: 'healthy',
          lastUsedAt: 0,
          vaultFilePath: vaultPath,
        },
      ],
    })
    if (!setAccountAlias('synthetic-account', 'desktop-alias')) {
      throw new Error('desktop alias failed')
    }
  } else if (action === 'delete') {
    if (!deleteCodexVaultFile(vaultPath)) {
      throw new Error('desktop delete failed')
    }
  } else {
    throw new Error(`unknown action: ${action}`)
  }
} else {
  throw new Error(`unknown role: ${role}`)
}

process.stdout.write(JSON.stringify({ role, action, pid: process.pid }))
