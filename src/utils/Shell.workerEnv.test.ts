import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exec } from './Shell.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { WORKER_ENV_ALLOWLIST_FLAG } from './workerSubprocessEnv.js'

/**
 * End-to-end cover for the worker environment allowlist: these run the real
 * exec, spawn a real shell, and read what the child actually got.
 *
 * The probe reports PRESENCE ONLY. It never prints a value, so a run of this
 * suite cannot put a credential into test output, a log, or a task output file.
 */
const PROBE_NAMES = [
  // Floor.
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  // Authored by exec on the spawn.
  'CLAUDECODE',
  'GIT_EDITOR',
  // Proxy and TLS trust root: the entries whose loss reads as a network fault.
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  // Live authority handle on this machine, deliberately not allowlisted.
  'SSH_AUTH_SOCK',
  // Neither allowlisted nor a credential. Its absence is what proves the
  // allowlist is doing the work rather than a denylist of known secret names.
  'CAT_CODE_TEST_BENIGN_UNLISTED',
  // Re-injected inside the shell by the session environment script, after any
  // spawn-time filter has run.
  'CAT_CODE_TEST_SESSION_ENV_INJECTED',
] as const

const PROBE_COMMAND = `for n in ${PROBE_NAMES.join(' ')}; do if printenv "$n" >/dev/null 2>&1; then echo "$n=present"; else echo "$n=absent"; fi; done`

const WORKER_AGENT_ID = 'agent_worker_env_test'

type Presence = Record<string, string>

async function probeChildEnv(agentId?: string): Promise<Presence> {
  const controller = new AbortController()
  const command = await exec(PROBE_COMMAND, controller.signal, 'bash', {
    agentId,
    preventCwdChanges: true,
    timeout: 60_000,
  })
  const result = await command.result
  const presence: Presence = {}
  for (const line of (result?.stdout ?? '').split('\n')) {
    const [name, state] = line.trim().split('=')
    if (name && state) {
      presence[name] = state
    }
  }
  return presence
}

const saved: Record<string, string | undefined> = {}
let envFileDir: string | undefined

function stash(name: string, value: string): void {
  saved[name] = process.env[name]
  process.env[name] = value
}

beforeAll(() => {
  // Harmless placeholders. None of these is a credential, and none is ever
  // printed: the probe reports presence only.
  stash('HTTPS_PROXY', 'http://127.0.0.1:9/')
  stash('NODE_EXTRA_CA_CERTS', '/dev/null')
  stash('CAT_CODE_TEST_BENIGN_UNLISTED', 'harmless')

  envFileDir = mkdtempSync(join(tmpdir(), 'catcode-worker-env-'))
  const envFile = join(envFileDir, 'session-env.sh')
  writeFileSync(envFile, 'export CAT_CODE_TEST_SESSION_ENV_INJECTED=1\n')
  stash('CLAUDE_ENV_FILE', envFile)
  invalidateSessionEnvCache()
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  delete process.env[WORKER_ENV_ALLOWLIST_FLAG]
  invalidateSessionEnvCache()
  if (envFileDir) {
    rmSync(envFileDir, { recursive: true, force: true })
  }
})

describe('flag off (the default)', () => {
  test(
    "a worker's shell gets exactly what the operator's shell gets",
    async () => {
      delete process.env[WORKER_ENV_ALLOWLIST_FLAG]

      const mainThread = await probeChildEnv(undefined)
      const worker = await probeChildEnv(WORKER_AGENT_ID)

      // The one that protects the operator's daily work: with the flag unset,
      // passing an agentId changes nothing about the child's environment.
      expect(worker).toEqual(mainThread)

      // And nothing is being narrowed at all: every probed name that exists in
      // the parent reaches the child, allowlisted or not.
      expect(mainThread.PATH).toBe('present')
      expect(mainThread.HOME).toBe('present')
      expect(mainThread.HTTPS_PROXY).toBe('present')
      expect(mainThread.NODE_EXTRA_CA_CERTS).toBe('present')
      expect(mainThread.CAT_CODE_TEST_BENIGN_UNLISTED).toBe('present')
      expect(mainThread.SSH_AUTH_SOCK).toBe(
        process.env.SSH_AUTH_SOCK ? 'present' : 'absent',
      )
      // The session environment script is still sourced inside the shell.
      expect(mainThread.CAT_CODE_TEST_SESSION_ENV_INJECTED).toBe('present')
    },
    120_000,
  )
})

describe('flag on', () => {
  test(
    'a worker-scoped exec gets only allowlisted names',
    async () => {
      process.env[WORKER_ENV_ALLOWLIST_FLAG] = '1'
      const worker = await probeChildEnv(WORKER_AGENT_ID)

      // Asserted as one map so a regression reports every difference at once
      // rather than stopping at the first name.
      expect(worker).toEqual({
        // Floor: still a usable shell. HOME especially, without which
        // `git config user.name` is empty and a worker's `git commit` fails.
        PATH: 'present',
        HOME: 'present',
        SHELL: 'present',
        TMPDIR: process.env.TMPDIR ? 'present' : 'absent',
        // exec's own settings survive its own filter.
        CLAUDECODE: 'present',
        GIT_EDITOR: 'present',
        // Proxy and TLS trust roots survive.
        HTTPS_PROXY: 'present',
        NODE_EXTRA_CA_CERTS: 'present',
        // A live authority handle, excluded by decision.
        SSH_AUTH_SOCK: 'absent',
        // Not allowlisted, not a credential: gone anyway. This is the allowlist
        // doing the work rather than a denylist of known secret names.
        CAT_CODE_TEST_BENIGN_UNLISTED: 'absent',
        // Re-injection path: the session environment script is sourced inside
        // the shell, so a spawn-time filter cannot see it. It is skipped.
        CAT_CODE_TEST_SESSION_ENV_INJECTED: 'absent',
      })
    },
    120_000,
  )

  test(
    'a main-thread exec is untouched even with the flag on',
    async () => {
      process.env[WORKER_ENV_ALLOWLIST_FLAG] = '1'
      const withFlag = await probeChildEnv(undefined)

      delete process.env[WORKER_ENV_ALLOWLIST_FLAG]
      const withoutFlag = await probeChildEnv(undefined)

      expect(withFlag).toEqual(withoutFlag)
      expect(withFlag.CAT_CODE_TEST_BENIGN_UNLISTED).toBe('present')
      expect(withFlag.CAT_CODE_TEST_SESSION_ENV_INJECTED).toBe('present')
    },
    120_000,
  )
})
