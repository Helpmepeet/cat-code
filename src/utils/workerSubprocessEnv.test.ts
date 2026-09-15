import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyWorkerEnvAllowlist,
  isWorkerEnvAllowlistEnabled,
  isWorkerScopedExec,
  WORKER_ENV_ALLOWLIST,
  WORKER_ENV_ALLOWLIST_FLAG,
} from './workerSubprocessEnv.js'

const originalFlag = process.env[WORKER_ENV_ALLOWLIST_FLAG]

// The export is a const tuple of literals; widen it so toContain can be called
// with a name that is not already in the tuple.
const ALLOWLIST: readonly string[] = WORKER_ENV_ALLOWLIST

function setFlag(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[WORKER_ENV_ALLOWLIST_FLAG]
  } else {
    process.env[WORKER_ENV_ALLOWLIST_FLAG] = value
  }
}

afterEach(() => {
  setFlag(originalFlag)
})

describe('the flag', () => {
  test('is fork-local and does not reuse the upstream scrub flag', () => {
    expect(WORKER_ENV_ALLOWLIST_FLAG).toBe('CAT_CODE_WORKER_ENV_ALLOWLIST')
    expect(WORKER_ENV_ALLOWLIST_FLAG).not.toContain('CLAUDE_CODE')
  })

  test('is off when unset, and a worker exec is not scoped', () => {
    setFlag(undefined)
    expect(isWorkerEnvAllowlistEnabled()).toBe(false)
    expect(isWorkerScopedExec('agent_1')).toBe(false)
  })

  test('is off for a falsy value', () => {
    setFlag('0')
    expect(isWorkerEnvAllowlistEnabled()).toBe(false)
    setFlag('')
    expect(isWorkerEnvAllowlistEnabled()).toBe(false)
    setFlag('no')
    expect(isWorkerEnvAllowlistEnabled()).toBe(false)
  })

  test('is on for the values isEnvTruthy accepts', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
      setFlag(truthy)
      expect(isWorkerEnvAllowlistEnabled()).toBe(true)
    }
  })
})

describe('isWorkerScopedExec', () => {
  test('needs both the flag and an agentId', () => {
    setFlag('1')
    expect(isWorkerScopedExec('agent_1')).toBe(true)
    // Main thread: ToolUseContext.agentId is set only for subagents.
    expect(isWorkerScopedExec(undefined)).toBe(false)
  })
})

describe('the allowlist', () => {
  test('carries the floor a shell cannot work without', () => {
    for (const name of [
      'PATH',
      'HOME',
      'TMPDIR',
      'PWD',
      'SHELL',
      'USER',
      'LOGNAME',
    ]) {
      expect(ALLOWLIST).toContain(name)
    }
  })

  test('carries the proxy and TLS trust-root block', () => {
    // The entries a hand-written list forgets. Losing them looks like a network
    // fault, not a missing variable.
    for (const name of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'NO_PROXY',
      'no_proxy',
      'SSL_CERT_FILE',
      'NODE_EXTRA_CA_CERTS',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
    ]) {
      expect(ALLOWLIST).toContain(name)
    }
  })

  test('excludes the authority handles that are live on this machine', () => {
    for (const name of [
      'SSH_AUTH_SOCK',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'SECURITYSESSIONID',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    ]) {
      expect(ALLOWLIST).not.toContain(name)
    }
  })

  test('has no duplicate entries', () => {
    expect(new Set(ALLOWLIST).size).toBe(ALLOWLIST.length)
  })
})

describe('applyWorkerEnvAllowlist', () => {
  test('keeps allowlisted names and drops everything else', () => {
    const narrowed = applyWorkerEnvAllowlist({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      // Neither allowlisted nor a credential. Its absence is what proves the
      // list is doing the work rather than a denylist of known secret names.
      CAT_CODE_TEST_BENIGN_UNLISTED: 'harmless',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    })
    expect(Object.keys(narrowed).sort()).toEqual([
      'HOME',
      'HTTPS_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'PATH',
    ])
  })

  test('preserves an undefined value so child_process still unsets the name', () => {
    // exec passes SHELL: undefined for a non-bash shell and relies on
    // child_process dropping undefined-valued keys.
    const narrowed = applyWorkerEnvAllowlist({ SHELL: undefined, PATH: '/bin' })
    expect('SHELL' in narrowed).toBe(true)
    expect(narrowed.SHELL).toBeUndefined()
  })

  test('does not mutate the input', () => {
    const input = { PATH: '/bin', SSH_AUTH_SOCK: '/tmp/agent.sock' }
    applyWorkerEnvAllowlist(input)
    expect(input.SSH_AUTH_SOCK).toBe('/tmp/agent.sock')
  })

  test('keeps the names exec authors on the spawn itself', () => {
    // If the filter stripped these, exec would undo its own settings, since it
    // runs over the fully composed object rather than over subprocessEnv alone.
    const narrowed = applyWorkerEnvAllowlist({
      CLAUDECODE: '1',
      GIT_EDITOR: 'true',
      CLAUDE_CODE_SESSION_ID: 'session',
      TMUX: '/tmp/claude-tmux',
      CLAUDE_CODE_TMPDIR: '/tmp/sandbox',
      TMPPREFIX: '/tmp/sandbox/zsh',
    })
    expect(Object.keys(narrowed).length).toBe(6)
  })
})
