import { describe, expect, test } from 'bun:test'
import { parseMarketplaceInput } from './parseMarketplaceInput.js'
import { validateOfficialNameSource } from './schemas.js'

const RESERVED_NAME = 'claude-code-plugins'

function expectAccepted(source: {
  source: string
  repo?: string
  url?: string
}): void {
  expect(validateOfficialNameSource(RESERVED_NAME, source)).toBeNull()
}

function expectRejected(source: {
  source: string
  repo?: string
  url?: string
}): void {
  expect(validateOfficialNameSource(RESERVED_NAME, source)).not.toBeNull()
}

describe('reserved marketplace source authentication', () => {
  test('accepts canonical official HTTPS Git URLs', () => {
    expectAccepted({
      source: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official.git',
    })
    expectAccepted({
      source: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official',
    })
    expectAccepted({
      source: 'git',
      url: 'https://github.com:443/anthropics/claude-plugins-official.git',
    })
    expectAccepted({
      source: 'git',
      url: 'https://github.com:0443/anthropics/claude-plugins-official.git',
    })
    expectAccepted({
      source: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official/',
    })
    expectAccepted({
      source: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official.git/',
    })
    expectAccepted({
      source: 'git',
      url: 'https://www.github.com/anthropics/claude-plugins-official.git',
    })
    expectAccepted({
      source: 'git',
      url: 'https://github.com/anthropics/claude-pl%75gins-official.git',
    })
  })

  test('accepts supported GitHub SSH usernames and repository syntax', () => {
    expectAccepted({
      source: 'git',
      url: 'git@github.com:anthropics/claude-plugins-official.git',
    })
    expectAccepted({
      source: 'git',
      url: 'org-123456@github.com:anthropics/claude-plugins-official',
    })
    expectAccepted({
      source: 'git',
      url: 'ssh://git@github.com/anthropics/claude-plugins-official.git',
    })
    expectAccepted({
      source: 'git',
      url: 'ssh://org-123456@github.com:22/anthropics/claude-plugins-official',
    })
    expectAccepted({
      source: 'git',
      url: 'ssh://git@github.com:00022/anthropics/claude-plugins-official.git',
    })
  })

  test('rejects URLs whose host or authority is not canonical GitHub', () => {
    for (const url of [
      'https://attacker.example/github.com/anthropics/repo.git',
      'https://github.com.attacker.example/anthropics/repo.git',
      'https://github.com@attacker.example/anthropics/repo.git',
      'https://attacker@github.com/anthropics/repo.git',
      'https://github.com:444/anthropics/repo.git',
      'https://github.com:8443/anthropics/repo.git',
      'https://github.com\t/anthropics/repo.git',
      'https://github.com/anthropics/repo//',
      'https://www.github.com.evil/anthropics/repo.git',
    ]) {
      expectRejected({ source: 'git', url })
    }
  })

  test('rejects malformed or non-exact organization and repository paths', () => {
    for (const url of [
      'https://github.com/anthropics-extra/repo.git',
      'https://github.com/notanthropics/repo.git',
      'https://github.com/anthropics-suffix/repo.git',
      'https://github.com/anthropics/repo/extra.git',
      'https://github.com/anthropics/../repo.git',
      'https://github.com/anthropics%2Frepo.git',
      'https://github.com/anthropics/repo.git?redirect=github.com/anthropics/x',
      'https://github.com/anthropics/repo.git#github.com/anthropics/x',
      'https://[github.com/anthropics/repo.git',
      'git@attacker.example:github.com/anthropics/repo.git',
      'git@github.com:anthropics-extra/repo.git',
      'git@github.com:anthropics/repo/../other.git',
      'https://github.com/anthropics/repo%2Fother.git',
      'https://github.com/anthropics/%2e%2e.git',
      'https://github.com/anthropics/repo%252Fother.git',
      'https://github.com/anthropics/repo%00.git',
      'https://github.com/anthropics/repo%ZZ.git',
      'ssh://git@attacker.example/anthropics/repo.git',
      'ssh://git@github.com@attacker.example/anthropics/repo.git',
      'ssh://git:password@github.com/anthropics/repo.git',
      'ssh://git@github.com:2222/anthropics/repo.git',
      'ssh://git@github.com/anthropics/repo.git?ref=main',
      'ssh://git@github.com/anthropics/repo.git#main',
      'ssh://git@@github.com/anthropics/repo.git',
    ]) {
      expectRejected({ source: 'git', url })
    }
  })

  test('requires an exact well-formed repository in GitHub shorthand sources', () => {
    expectAccepted({ source: 'github', repo: 'anthropics/claude-code-plugins' })
    for (const repo of [
      'anthropics-extra/repo',
      'notanthropics/repo',
      '/anthropics/repo',
      'anthropics/repo/extra',
      'anthropics/../repo',
      'anthropics/repo?redirect=anthropics/other',
      'anthropics/repo#fragment',
    ]) {
      expectRejected({ source: 'github', repo })
    }
  })

  test('parses valid official URLs while rejecting embedded-origin spoofing', async () => {
    const official = await parseMarketplaceInput(
      'https://github.com/anthropics/claude-plugins-official.git',
    )
    expect(official).toEqual({
      source: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official.git',
    })
    if (official && 'source' in official) {
      expectAccepted(official)
    }

    const spoofed = await parseMarketplaceInput(
      'https://attacker.example/github.com/anthropics/repo.git',
    )
    expect(spoofed).toEqual({
      source: 'git',
      url: 'https://attacker.example/github.com/anthropics/repo.git',
    })
    if (spoofed && 'source' in spoofed) {
      expectRejected(spoofed)
    }
  })
})
