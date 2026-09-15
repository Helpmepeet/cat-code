import { describe, expect, test } from 'bun:test'
import type { LogOption } from '../types/logs.js'
import { buildLogLabel } from './LogSelector.js'

describe('buildLogLabel', () => {
  test('does not expose legacy Agent Mode in a session label', () => {
    const log: LogOption = {
      date: '2026-09-07',
      messages: [],
      value: 0,
      created: new Date('2026-09-07T00:00:00Z'),
      modified: new Date('2026-09-07T00:00:00Z'),
      firstPrompt: 'legacy session',
      messageCount: 1,
      isSidechain: false,
      mode: 'agent',
    }

    expect(buildLogLabel(log, 80)).toBe('legacy session')
  })
})
