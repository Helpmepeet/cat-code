import { describe, expect, test } from 'bun:test'
import {
  buildIdFromGitOutputs,
  formatBuildId,
} from './buildProvenance.js'

describe('build provenance', () => {
  test('classifies a clean source build by its commit', () => {
    expect(formatBuildId('A1B2C3D4e5f6a7b8', false)).toBe('a1b2c3d4')
  })

  test('makes dirty source explicit without changing the commit identity', () => {
    expect(formatBuildId('a1b2c3d4e5f6a7b8', true)).toBe(
      'a1b2c3d4-dirty',
    )
  })

  test('does not invent provenance when the commit is unavailable', () => {
    expect(formatBuildId(null, false)).toBe('unknown')
    expect(formatBuildId('unknown', true)).toBe('unknown')
  })

  test('does not claim clean when the dirty-state query fails', () => {
    expect(buildIdFromGitOutputs('a1b2c3d4e5f6a7b8', null)).toBe('unknown')
    expect(buildIdFromGitOutputs(null, '')).toBe('unknown')
  })
})
