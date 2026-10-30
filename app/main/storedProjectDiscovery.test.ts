import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceJumpCoordinator } from './workspaceJumpCoordinator.js'
import type { PeerRegistryRow } from './peerRequestPlane.js'

// No project sessions are needed for a stored project to be discoverable.
test('workspace discovery uses stored names and still gates empty projects on saved trust', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stored-project-discovery-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const id = randomUUID(), generation = randomUUID()
  const row: PeerRegistryRow = { appSessionId: id, engineSessionId: randomUUID(), cwd: '/managed/chat',
    binding: { kind: 'managed', storageRootId: randomUUID(), storageId: randomUUID() },
    lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null }
  let trusted = true
  const coordinator = new WorkspaceJumpCoordinator({
    directory: join(directory, 'jumps'), row: target => target === id ? row : undefined,
    knownProjects: () => [{ path: '/stored', name: 'Chosen name', lastUsedAt: 10 }],
    validateCwd: path => ({ ok: true, realpath: path }), trustedProjectRoots: async roots => trusted ? roots : [],
    verifyReady: () => false, control: async () => ({ kind: 'timeout' }),
    host: { getSessionGeneration: () => generation, reserveWorkspaceJump: async () => ({ ok: true, value: undefined }),
      releaseWorkspaceJump: () => {}, moveWorkspaceJump: async () => { throw new Error('Discovery cannot move a chat') } },
  })
  try {
    const first = await coordinator.handleRequest(id, { verb: 'workspaces.list' })
    expect(first).toMatchObject({ ok: true, value: { eligible: true, workspaces: [{ name: 'Chosen name', path: '/stored' }] } })
    if (!first.ok || !('workspaces' in first.value)) throw new Error('Expected workspace listing')
    const destinationHandle = first.value.workspaces[0]!.handle
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
