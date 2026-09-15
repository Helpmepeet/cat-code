import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { ripGrep } from './ripgrep.js'

const TARGET = join(import.meta.dir, 'ripgrep.ts')

async function expectRipgrepError(
  args: string[],
  diagnostic: string,
): Promise<void> {
  let caught: unknown
  try {
    await ripGrep(args, TARGET, new AbortController().signal)
  } catch (error) {
    caught = error
  }

  if (!(caught instanceof Error)) {
    throw new Error('Expected ripGrep to reject with an error')
  }
  expect(caught.message).toContain('ripgrep search failed with exit code 2')
  expect(caught.message).toContain(diagnostic)
}

describe('ripGrep', () => {
  test('rejects malformed regular expressions with ripgrep diagnostics', async () => {
    await expectRipgrepError(['['], 'unclosed character class')
  })

  test('rejects unknown ripgrep file types with diagnostics', async () => {
    await expectRipgrepError(
      ['--type', 'definitely_not_a_registered_rg_type', 'export'],
      'unrecognized file type',
    )
  })

  test('resolves an empty result for a normal no-match search', async () => {
    await expect(
      ripGrep(
        ['__cat_code_ripgrep_no_match_9d6f8c2a__'],
        TARGET,
        new AbortController().signal,
      ),
    ).resolves.toEqual([])
  })
})
