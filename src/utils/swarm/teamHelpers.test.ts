import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  allocateTeamRecipient,
  getTeamDir,
  readTeamSnapshot,
  recoverStartingRecipient,
  RecipientConflictError,
  RecipientTransitionError,
  TeamProtocolVersionError,
  tombstoneFailedRecipient,
  transactTeamFile,
  transitionTeamRecipient,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'

describe('teamHelpers versioned transactions', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'team-helpers-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function seedTeam(teamName: string): Promise<void> {
    const teamFile: TeamFile = {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: `team-lead@${teamName}`,
      teamProtocolVersion: 2,
      recipientRecords: [
        {
          allocationId: 'allocation-lead',
          key: 'team-lead',
          name: 'team-lead',
          kind: 'leader',
          agentId: `team-lead@${teamName}`,
          sessionId: 'session-lead',
          status: 'active',
          launcherPid: process.pid,
          launcherInstanceId: 'test-instance',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      members: [
        {
          agentId: `team-lead@${teamName}`,
          name: 'team-lead',
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: tempDir,
          subscriptions: [],
        },
      ],
    }
    await writeTeamFileAsync(teamName, teamFile)
  }

  test('publishes an async team-file replacement without leaving a temp file', async () => {
    await seedTeam('review-team')
    const before = await readTeamSnapshot('review-team')

    await writeTeamFileAsync('review-team', {
      ...before,
      createdAt: before.createdAt + 1,
    })

    await expect(readTeamSnapshot('review-team')).resolves.toMatchObject({
      createdAt: before.createdAt + 1,
    })
    expect(readdirSync(getTeamDir('review-team'))).toEqual(['config.json'])
  })

  test('readTeamSnapshot and transactTeamFile reject a legacy (non-version-2) team file', async () => {
    await writeTeamFileAsync('legacy-team', {
      name: 'legacy-team',
      createdAt: Date.now(),
      leadAgentId: 'team-lead@legacy-team',
      members: [],
    })

    await expect(readTeamSnapshot('legacy-team')).rejects.toBeInstanceOf(
      TeamProtocolVersionError,
    )
    await expect(
      transactTeamFile('legacy-team', teamFile => ({ teamFile, result: undefined })),
    ).rejects.toBeInstanceOf(TeamProtocolVersionError)
  })

  test('allocateTeamRecipient rejects a canonicalized-collision key under conflict:"error"', async () => {
    await seedTeam('review-team')
    await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'Researcher',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })

    await expect(
      allocateTeamRecipient({
        teamName: 'review-team',
        requestedName: 'researcher',
        kind: 'teammate',
        conflict: 'error',
        forbiddenKeys: new Set(),
        sessionId: 'session-1',
      }),
    ).rejects.toBeInstanceOf(RecipientConflictError)
  })

  test('allocateTeamRecipient finds a free suffix under conflict:"suffix"', async () => {
    await seedTeam('review-team')
    const first = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'researcher',
      kind: 'teammate',
      conflict: 'suffix',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })
    const second = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'researcher',
      kind: 'teammate',
      conflict: 'suffix',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })

    expect(first.name).toBe('researcher')
    expect(first.agentId).toBe('researcher@review-team')
    expect(second.name).toBe('researcher-2')
    expect(second.agentId).toBe('researcher-2@review-team')
    expect(first.allocationId).not.toBe(second.allocationId)
  })

  test('concurrent allocations of the same base name under conflict:"suffix" never collide', async () => {
    await seedTeam('review-team')

    const [first, second] = await Promise.all([
      allocateTeamRecipient({
        teamName: 'review-team',
        requestedName: 'researcher',
        kind: 'teammate',
        conflict: 'suffix',
        forbiddenKeys: new Set(),
        sessionId: 'session-1',
      }),
      allocateTeamRecipient({
        teamName: 'review-team',
        requestedName: 'researcher',
        kind: 'teammate',
        conflict: 'suffix',
        forbiddenKeys: new Set(),
        sessionId: 'session-1',
      }),
    ])

    expect([first.name, second.name].sort()).toEqual([
      'researcher',
      'researcher-2',
    ])
    expect(first.allocationId).not.toBe(second.allocationId)

    const snapshot = await readTeamSnapshot('review-team')
    const teammateRecords = snapshot.recipientRecords!.filter(
      r => r.kind === 'teammate',
    )
    expect(teammateRecords).toHaveLength(2)
  })

  test('terminated allocations remain tombstones and are never reused by key or allocationId', async () => {
    await seedTeam('review-team')
    const allocated = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'alice',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })
    await transitionTeamRecipient({
      teamName: 'review-team',
      allocationId: allocated.allocationId,
      from: 'reserved',
      to: 'terminated',
    })

    await expect(
      allocateTeamRecipient({
        teamName: 'review-team',
        requestedName: 'alice',
        kind: 'teammate',
        conflict: 'error',
        forbiddenKeys: new Set(),
        sessionId: 'session-1',
      }),
    ).rejects.toBeInstanceOf(RecipientConflictError)

    const bySuffix = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'alice',
      kind: 'teammate',
      conflict: 'suffix',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })
    expect(bySuffix.name).toBe('alice-2')
    expect(bySuffix.allocationId).not.toBe(allocated.allocationId)
  })

  test('transitionTeamRecipient fails closed on an invalid or duplicate transition', async () => {
    await seedTeam('review-team')
    const allocated = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'bob',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })

    await transitionTeamRecipient({
      teamName: 'review-team',
      allocationId: allocated.allocationId,
      from: 'reserved',
      to: 'starting',
    })

    // Wrong `from` state: fails closed rather than clobbering.
    await expect(
      transitionTeamRecipient({
        teamName: 'review-team',
        allocationId: allocated.allocationId,
        from: 'reserved',
        to: 'active',
      }),
    ).rejects.toBeInstanceOf(RecipientTransitionError)

    // Unknown allocation ID: fails closed.
    await expect(
      transitionTeamRecipient({
        teamName: 'review-team',
        allocationId: 'nonexistent-allocation',
        from: 'starting',
        to: 'active',
      }),
    ).rejects.toBeInstanceOf(RecipientTransitionError)
  })

  test('transitionTeamRecipient upserts the member record on activation', async () => {
    await seedTeam('review-team')
    const allocated = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'carol',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })
    await transitionTeamRecipient({
      teamName: 'review-team',
      allocationId: allocated.allocationId,
      from: 'reserved',
      to: 'active',
      member: {
        agentId: 'stale@review-team',
        allocationId: 'stale-allocation',
        name: 'stale-name',
        joinedAt: Date.now(),
        tmuxPaneId: 'pane-1',
        cwd: tempDir,
        subscriptions: [],
        backendType: 'tmux',
      },
    })

    const snapshot = await readTeamSnapshot('review-team')
    const record = snapshot.recipientRecords!.find(
      r => r.allocationId === allocated.allocationId,
    )
    expect(record?.status).toBe('active')
    expect(record?.agentId).toBe('carol@review-team')
    const member = snapshot.members.find(m => m.agentId === 'carol@review-team')
    expect(member).toMatchObject({
      allocationId: allocated.allocationId,
      name: 'carol',
      tmuxPaneId: 'pane-1',
    })
  })

  test('recoverStartingRecipient tombstones a starting allocation whose launcher is confirmed dead', async () => {
    await seedTeam('review-team')
    // A PID that (almost certainly) does not correspond to a live process.
    const deadPid = 999_999
    await transactTeamFile('review-team', teamFile => ({
      teamFile: {
        ...teamFile,
        recipientRecords: [
          ...teamFile.recipientRecords!,
          {
            allocationId: 'allocation-dead',
            key: 'dave',
            name: 'dave',
            kind: 'teammate' as const,
            agentId: 'dave@review-team',
            sessionId: 'session-1',
            status: 'starting' as const,
            launcherPid: deadPid,
            launcherInstanceId: 'dead-instance',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      result: undefined,
    }))

    const outcome = await recoverStartingRecipient({
      teamName: 'review-team',
      allocationId: 'allocation-dead',
    })
    expect(outcome).toBe('terminated')

    const snapshot = await readTeamSnapshot('review-team')
    const record = snapshot.recipientRecords!.find(
      r => r.allocationId === 'allocation-dead',
    )
    expect(record?.status).toBe('terminated')
  })

  test('recoverStartingRecipient reports manual_cleanup_required for a live launcher', async () => {
    await seedTeam('review-team')
    await transactTeamFile('review-team', teamFile => ({
      teamFile: {
        ...teamFile,
        recipientRecords: [
          ...teamFile.recipientRecords!,
          {
            allocationId: 'allocation-live',
            key: 'erin',
            name: 'erin',
            kind: 'teammate' as const,
            agentId: 'erin@review-team',
            sessionId: 'session-1',
            status: 'starting' as const,
            launcherPid: process.pid,
            launcherInstanceId: 'this-instance',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      result: undefined,
    }))

    const outcome = await recoverStartingRecipient({
      teamName: 'review-team',
      allocationId: 'allocation-live',
    })
    expect(outcome).toBe('manual_cleanup_required')
  })

  test('rejects invalid or reserved new teammate names at allocation time', async () => {
    await seedTeam('review-team')
    await expect(
      allocateTeamRecipient({
        teamName: 'review-team',
        requestedName: 'foo@bar',
        kind: 'teammate',
        conflict: 'error',
        forbiddenKeys: new Set(),
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('Invalid teammate name')
  })

  test('suffix allocation degrades gracefully for a near-max-length base name', async () => {
    await seedTeam('review-team')
    const longName = 'a'.repeat(63)
    await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: longName,
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })

    // The base name is already at 63 bytes; appending "-2" would exceed the
    // 64-byte cap and previously threw InvalidTeammateNameError instead of
    // finding a shorter unique candidate.
    const suffixed = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: longName,
      kind: 'teammate',
      conflict: 'suffix',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })
    expect(suffixed.name.endsWith('-2')).toBe(true)
    expect(Buffer.byteLength(suffixed.name, 'utf8')).toBeLessThanOrEqual(64)
  })

  test('local and teammate kinds share one collision namespace', async () => {
    await seedTeam('review-team')
    await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'researcher',
      kind: 'local',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })

    await expect(
      allocateTeamRecipient({
        teamName: 'review-team',
        requestedName: 'researcher',
        kind: 'teammate',
        conflict: 'error',
        forbiddenKeys: new Set(),
        sessionId: 'session-1',
      }),
    ).rejects.toBeInstanceOf(RecipientConflictError)
  })

  test('tombstoneFailedRecipient reclaims a leaked "reserved" allocation (never transitioned to starting)', async () => {
    await seedTeam('review-team')
    const allocated = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'frank',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })

    // Simulate a caller that failed before the spawn handler ever reached
    // its own reserved -> starting transition (the exact leak this helper
    // exists to close).
    await tombstoneFailedRecipient('review-team', allocated.allocationId)

    const snapshot = await readTeamSnapshot('review-team')
    const record = snapshot.recipientRecords!.find(
      r => r.allocationId === allocated.allocationId,
    )
    expect(record?.status).toBe('terminated')

    // The name is now a permanent tombstone, not silently reusable.
    await expect(
      allocateTeamRecipient({
        teamName: 'review-team',
        requestedName: 'frank',
        kind: 'teammate',
        conflict: 'error',
        forbiddenKeys: new Set(),
        sessionId: 'session-1',
      }),
    ).rejects.toBeInstanceOf(RecipientConflictError)
  })

  test('tombstoneFailedRecipient also reclaims a "starting" allocation', async () => {
    await seedTeam('review-team')
    const allocated = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'grace',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })
    await transitionTeamRecipient({
      teamName: 'review-team',
      allocationId: allocated.allocationId,
      from: 'reserved',
      to: 'starting',
    })

    await tombstoneFailedRecipient('review-team', allocated.allocationId)

    const snapshot = await readTeamSnapshot('review-team')
    const record = snapshot.recipientRecords!.find(
      r => r.allocationId === allocated.allocationId,
    )
    expect(record?.status).toBe('terminated')
  })

  test('tombstoneFailedRecipient is a safe no-op once the allocation is already active or terminated', async () => {
    await seedTeam('review-team')
    const allocated = await allocateTeamRecipient({
      teamName: 'review-team',
      requestedName: 'henry',
      kind: 'teammate',
      conflict: 'error',
      forbiddenKeys: new Set(),
      sessionId: 'session-1',
    })
    await transitionTeamRecipient({
      teamName: 'review-team',
      allocationId: allocated.allocationId,
      from: 'reserved',
      to: 'active',
    })

    // Must not throw, and must not clobber the active record.
    await tombstoneFailedRecipient('review-team', allocated.allocationId)

    const snapshot = await readTeamSnapshot('review-team')
    const record = snapshot.recipientRecords!.find(
      r => r.allocationId === allocated.allocationId,
    )
    expect(record?.status).toBe('active')
  })
})
