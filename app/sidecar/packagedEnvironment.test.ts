import { describe, expect, test } from 'bun:test'
import { delimiter, join } from 'node:path'

import {
  packagedBinPath,
  prependPackagedBinToPath,
} from './packagedEnvironment.js'

describe('packaged sidecar environment', () => {
  const execPath = join(
    '/Applications',
    'Cat Code.app',
    'Contents',
    'Resources',
    'sidecar',
    'cat-code-sidecar',
  )
  const bin = join(
    '/Applications',
    'Cat Code.app',
    'Contents',
    'Resources',
    'bin',
  )

  test('derives the companion bin directory without hardcoding the install location', () => {
    expect(packagedBinPath(execPath)).toBe(bin)
  })

  test('puts the companion bin first and does not duplicate it', () => {
    expect(
      prependPackagedBinToPath(
        execPath,
        ['/usr/bin', bin, '/bin'].join(delimiter),
      ),
    ).toBe([bin, '/usr/bin', '/bin'].join(delimiter))
  })

  test('constructs a usable PATH when the parent has none', () => {
    expect(prependPackagedBinToPath(execPath, undefined)).toBe(bin)
  })
})
