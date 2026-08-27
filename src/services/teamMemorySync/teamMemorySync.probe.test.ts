import { expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

test('terminal pull reports conflict instead of replacing a desktop memory edit', async () => {
  const memoryPath = await mkdtemp(join(tmpdir(), 'team-memory-cas-'))
  const teamPath = join(memoryPath, 'team')
  await mkdir(teamPath)
  await writeFile(join(teamPath, 'topic.md'), 'initial', 'utf8')
  const readyPath = join(memoryPath, 'terminal-ready')
  const childPath = join(import.meta.dir, 'teamMemorySync.probe.child.ts')
  const children = ['terminal-pull', 'desktop-extraction'].map(role =>
    Bun.spawn([process.execPath, childPath, role, memoryPath, readyPath], {
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
    const [stdout, stderr] = await Promise.all([
      Promise.all(
        children.map(child => new Response(child.stdout).text()),
      ),
      Promise.all(
        children.map(child => new Response(child.stderr).text()),
      ),
    ])
    expect(exits, stderr.join('\n')).toEqual([0, 0])
    const results = stdout.map(value =>
      JSON.parse(value) as {
        role: string
        pid: number
        firstAttempt?: { filesWritten: number; conflicts: string[] }
        retry?: { filesWritten: number; conflicts: string[] }
      },
    )
    expect(results.map(result => result.pid).sort()).toEqual(recordedPids.sort())
    expect(
      results.find(result => result.role === 'terminal-pull')?.firstAttempt,
    ).toEqual({
      filesWritten: 0,
      conflicts: ['topic.md'],
    })
    expect(
      results.find(result => result.role === 'terminal-pull')?.retry,
    ).toEqual({
      filesWritten: 1,
      conflicts: [],
    })
    expect(await readFile(join(teamPath, 'topic.md'), 'utf8')).toBe(
      'remote-content',
    )
  } finally {
    await Promise.all(children.map(child => child.exited))
    await rm(memoryPath, { recursive: true, force: true })
  }
})

test('pull retries the body after a publication conflict before advancing sync state', async () => {
  const memoryPath = await mkdtemp(join(tmpdir(), 'team-memory-pull-state-'))
  const teamPath = join(memoryPath, 'team')
  await mkdir(teamPath)
  await writeFile(join(teamPath, 'topic.md'), 'local-content', 'utf8')

  const previousOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryPath

  const remoteChecksum = 'sha256:remote-snapshot'
  const oldChecksum = 'sha256:applied-snapshot'
  const oldEntryChecksum = 'sha256:applied-topic'
  const remoteEntryChecksum = 'sha256:remote-topic'
  const conditionalHeaders: Array<string | undefined> = []
  const axiosGet = mock(
    async (_url: string, options: { headers?: Record<string, string> }) => {
      const conditionalHeader = options.headers?.['If-None-Match']
      conditionalHeaders.push(conditionalHeader)
      if (conditionalHeader === `"${remoteChecksum}"`) {
        return { status: 304, data: undefined, headers: {} }
      }
      return {
        status: 200,
        headers: { etag: `"${remoteChecksum}"` },
        data: {
          organizationId: 'synthetic-org',
          repo: 'synthetic/repo',
          version: 2,
          lastModified: '2026-08-27T00:00:00.000Z',
          checksum: remoteChecksum,
          content: {
            entries: { 'topic.md': 'remote-content' },
            entryChecksums: { 'topic.md': remoteEntryChecksum },
          },
        },
      }
    },
  )

  try {
    const [actualAtomic, actualAuth, actualGit, actualOauth, actualProviders] =
      await Promise.all([
        import('../../utils/atomicFile.js'),
        import('../../utils/auth.js'),
        import('../../utils/git.js'),
        import('../../constants/oauth.js'),
        import('../../utils/model/providers.js'),
      ])
    let publicationAttempts = 0
    const publishRealContent =
      actualAtomic.writeFileAtomicDurableIfContentMatches
    const publish = mock(
      async (
        filePath: string,
        expectedContent: string | null,
        content: string,
        options: Parameters<
          typeof actualAtomic.writeFileAtomicDurableIfContentMatches
        >[3],
      ) => {
        publicationAttempts++
        if (publicationAttempts === 1) return 'conflict' as const
        return publishRealContent(
          filePath,
          expectedContent,
          content,
          options,
        )
      },
    )

    await mock.module('src/utils/auth.js', () => ({
      ...actualAuth,
      checkAndRefreshOAuthTokenIfNeeded: async () => false,
      getClaudeAIOAuthTokens: () => ({
        accessToken: 'synthetic-access-token',
        scopes: ['synthetic-inference', 'synthetic-profile'],
      }),
    }))
    await mock.module('src/constants/oauth.js', () => ({
      ...actualOauth,
      CLAUDE_AI_INFERENCE_SCOPE: 'synthetic-inference',
      CLAUDE_AI_PROFILE_SCOPE: 'synthetic-profile',
      OAUTH_BETA_HEADER: 'synthetic-beta',
      getOauthConfig: () => ({ BASE_API_URL: 'https://synthetic.invalid' }),
    }))
    await mock.module('src/utils/model/providers.js', () => ({
      ...actualProviders,
      getAPIProvider: () => 'firstParty',
      isFirstPartyAnthropicBaseUrl: () => true,
    }))
    await mock.module('src/utils/git.js', () => ({
      ...actualGit,
      getGithubRepo: async () => 'synthetic/repo',
    }))
    await mock.module('src/utils/userAgent.js', () => ({
      getClaudeCodeUserAgent: () => 'synthetic-agent',
    }))
    await mock.module('src/utils/atomicFile.js', () => ({
      ...actualAtomic,
      writeFileAtomicDurableIfContentMatches: publish,
    }))
    await mock.module('src/utils/claudemd.js', () => ({
      clearMemoryFileCaches: () => {},
    }))
    await mock.module('axios', () => ({
      default: {
        get: axiosGet,
        isAxiosError: () => false,
      },
    }))

    const { createSyncState, pullTeamMemory } = await import('./index.js')
    const state = createSyncState()
    state.lastKnownChecksum = oldChecksum
    state.serverChecksums.set('topic.md', oldEntryChecksum)

    const conflicted = await pullTeamMemory(state)
    expect(conflicted.success).toBe(false)
    expect(state.lastKnownChecksum).toBe(oldChecksum)
    expect([...state.serverChecksums]).toEqual([
      ['topic.md', oldEntryChecksum],
    ])
    expect(await readFile(join(teamPath, 'topic.md'), 'utf8')).toBe(
      'local-content',
    )

    const retried = await pullTeamMemory(state)
    expect(retried).toMatchObject({ success: true, filesWritten: 1 })
    expect(conditionalHeaders).toEqual([
      `"${oldChecksum}"`,
      `"${oldChecksum}"`,
    ])
    expect(state.lastKnownChecksum).toBe(remoteChecksum)
    expect([...state.serverChecksums]).toEqual([
      ['topic.md', remoteEntryChecksum],
    ])
    expect(await readFile(join(teamPath, 'topic.md'), 'utf8')).toBe(
      'remote-content',
    )
  } finally {
    mock.restore()
    if (previousOverride === undefined) {
      delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    } else {
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = previousOverride
    }
    await rm(memoryPath, { recursive: true, force: true })
  }
}, 30_000)
