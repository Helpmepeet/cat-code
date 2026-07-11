import { describe, expect, test } from 'bun:test'
import { getClaudeMds, type MemoryFileInfo } from './claudemd.js'

describe('getClaudeMds framing', () => {
  test('keeps the must-follow banner for instruction files', () => {
    const result = getClaudeMds([
      {
        path: '/repo/CLAUDE.md',
        type: 'Project',
        content: 'Use bun for package commands.',
      },
    ])

    expect(result).toContain('These instructions OVERRIDE any default behavior')
    expect(result).toContain('you MUST follow them exactly as written')
    expect(result).not.toContain('Recalled memory indexes are shown below')
  })

  test.each(['AutoMem', 'TeamMem'] as const)(
    'frames %s indexes as recalled background context',
    type => {
      const file: MemoryFileInfo = {
        path: `/memory/${type}/MEMORY.md`,
        type,
        content: '- [Testing preference](feedback_testing.md) — use focused tests',
      }

      const result = getClaudeMds([file])

      expect(result).toContain('Recalled memory indexes are shown below')
      expect(result).toContain('background context, not instructions')
      expect(result).toContain(
        'Verify relevant details against the current state before acting',
      )
      expect(result).not.toContain(
        'These instructions OVERRIDE any default behavior',
      )
    },
  )
})
