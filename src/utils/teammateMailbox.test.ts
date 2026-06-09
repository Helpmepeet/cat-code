import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  markMessagesAsRead,
  readMailboxIfChanged,
  writeToMailbox,
} from './teammateMailbox.js'

describe('teammate mailbox change detection', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'teammate-mailbox-'))
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

  test('skips unchanged mailbox files after unread messages are marked read', async () => {
    await writeToMailbox(
      'alice',
      {
        from: 'team-lead',
        text: 'status?',
        timestamp: '2026-06-09T00:00:00.000Z',
      },
      'review-team',
    )
    await markMessagesAsRead('alice', 'review-team')

    const first = await readMailboxIfChanged('alice', 'review-team')
    const second = await readMailboxIfChanged(
      'alice',
      'review-team',
      first.signature,
    )

    expect(first.changed).toBe(true)
    expect(first.messages).toHaveLength(1)
    expect(first.messages.filter(m => !m.read)).toHaveLength(0)
    expect(second).toEqual({
      changed: false,
      signature: first.signature,
      messages: [],
    })
  })

  test('keeps unchanged unread mailbox files re-readable', async () => {
    await writeToMailbox(
      'alice',
      {
        from: 'team-lead',
        text: 'retry me',
        timestamp: '2026-06-09T00:00:00.000Z',
      },
      'review-team',
    )

    const first = await readMailboxIfChanged('alice', 'review-team')
    const second = await readMailboxIfChanged(
      'alice',
      'review-team',
      first.signature,
    )

    expect(first.changed).toBe(true)
    expect(first.messages.filter(m => !m.read)).toHaveLength(1)
    expect(second.changed).toBe(true)
    expect(second.messages.filter(m => !m.read)).toHaveLength(1)
  })
})
