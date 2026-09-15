import { readFile, writeFile } from 'fs/promises'
import { writeFileAtomicDurable } from '../../utils/atomicFile.js'
import {
  acquireCodexVaultFileLock,
  persistNextQuarantineProbe,
} from './codexTokenRefresh.js'
import { createCodexCredentialLifecycle } from './codexCredentialLifecycle.js'

const [role, vaultPath, readyPath] = process.argv.slice(2)
if (!role || !vaultPath || !readyPath) {
  throw new Error('expected role, vault path, and ready path')
}

if (role === 'terminal-verdict') {
  const release = await acquireCodexVaultFileLock(vaultPath, error => {
    throw error
  })
  try {
    await writeFile(readyPath, String(process.pid), 'utf8')
    await Bun.sleep(300)
    const current = JSON.parse(await readFile(vaultPath, 'utf8')) as Record<
      string,
      unknown
    >
    current.refresh = {
      state: 'reauth_required',
      reason: 'terminal verdict',
      refresh_token_hash: 'synthetic',
    }
    await writeFileAtomicDurable(
      vaultPath,
      `${JSON.stringify(current, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  } finally {
    await release()
  }
} else if (role === 'desktop-probe') {
  for (;;) {
    try {
      await readFile(readyPath)
      break
    } catch {
      await Bun.sleep(5)
    }
  }
  const current = JSON.parse(await readFile(vaultPath, 'utf8')) as {
    tokens?: {
      account_id?: string
      credential_generation?: number
    }
  }
  const accountId = current.tokens?.account_id
  const credentialGeneration = current.tokens?.credential_generation
  if (
    typeof accountId !== 'string' ||
    !Number.isSafeInteger(credentialGeneration)
  ) {
    throw new Error('expected a tagged credentialed probe profile')
  }
  await persistNextQuarantineProbe(
    vaultPath,
    'desktop backoff',
    accountId,
    credentialGeneration,
    {
      lifecycle: process.env.PROBE_LIFECYCLE_DIRECTORY
        ? createCodexCredentialLifecycle({
            directory: process.env.PROBE_LIFECYCLE_DIRECTORY,
          })
        : undefined,
    },
  )
} else {
  throw new Error(`unknown role: ${role}`)
}

process.stdout.write(JSON.stringify({ role, pid: process.pid }))
