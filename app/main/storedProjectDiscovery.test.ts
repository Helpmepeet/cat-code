import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceJumpCoordinator } from './workspaceJumpCoordinator.js'
import type { PeerRegistryRow } from './peerRequestPlane.js'
import { readProjectMetadata } from './projectMetadata.js'

// No project sessions are needed for a stored project to be discoverable.
test('workspace discovery uses stored names and still gates empty projects on saved trust', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stored-project-discovery-')))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const id = randomUUID(), generation = randomUUID()
  const row: PeerRegistryRow = { appSessionId: id, engineSessionId: randomUUID(), cwd: '/managed/chat',
    binding: { kind: 'managed', storageRootId: randomUUID(), storageId: randomUUID() },
    lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null }
  let trusted = true
  const root = join(directory, 'project')
  mkdirSync(join(root, '.cat-code'), { recursive: true })
  writeFileSync(join(root, '.cat-code', 'project.json'), JSON.stringify({ aliases: ['kitten', 'cat workspace'], description: 'An isolated project' }))
  const coordinator = new WorkspaceJumpCoordinator({
    directory: join(directory, 'jumps'), row: target => target === id ? row : undefined,
    knownProjects: () => [{ path: root, name: 'Chosen name', lastUsedAt: 10 }],
    validateCwd: path => ({ ok: true, realpath: path }), trustedProjectRoots: async roots => trusted ? roots : [],
    inspectTrustedProjects: async (roots, offset) => ({
      trustedRoots: trusted ? roots : [],
      metadata: trusted ? roots.slice(offset, offset + 8).map(path => ({ path, ...readProjectMetadata(path) })) : [],
    }),
    verifyReady: () => false, control: async () => ({ kind: 'timeout' }),
    host: { getSessionGeneration: () => generation, reserveWorkspaceJump: async () => ({ ok: true, value: undefined }),
      releaseWorkspaceJump: () => {}, moveWorkspaceJump: async () => { throw new Error('Discovery cannot move a chat') } },
  })
  try {
    const first = await coordinator.handleRequest(id, { verb: 'workspaces.list' })
    expect(first).toMatchObject({ ok: true, value: { eligible: true, workspaces: [{ name: 'Chosen name', path: root, aliases: ['kitten', 'cat workspace'], description: 'An isolated project' }] } })
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(16 * 1024)
    if (!first.ok || !('workspaces' in first.value)) throw new Error('Expected workspace listing')
    const destinationHandle = first.value.workspaces[0]!.handle
    writeFileSync(join(root, '.cat-code', 'project.json'), '{invalid')
    expect(await coordinator.handleRequest(id, { verb: 'workspaces.list' })).toMatchObject({
      ok: true, value: { workspaces: [{ metadataWarning: expect.any(String) }] },
    })
    trusted = false
    expect(await coordinator.handleRequest(id, { verb: 'workspaces.list' })).toEqual({ ok: true, value: { eligible: true, workspaces: [] } })
    expect((await coordinator.handleRequest(id, { verb: 'workspace.jump', destinationHandle, operationId: randomUUID() })).ok).toBe(false)
  } finally {
    coordinator.dispose()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
