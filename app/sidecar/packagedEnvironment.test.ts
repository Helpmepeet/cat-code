import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import {
  packagedBinPath,
  prependPackagedBinToPath,
  resolvePackagedSidecarPath,
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

  test('finds user tools when a packaged app starts with only the GUI PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'catcode-packaged-path-'))
    const toolDir = join(home, 'tools')
    mkdirSync(toolDir)
    writeFileSync(join(home, '.zprofile'), 'printf "shell startup message\\n"\n')
    writeFileSync(
      join(home, '.zshrc'),
      'if [ -n "$CATCODE_TEST_SECRET" ]; then touch "$HOME/secret-exposed"; fi\n' +
        'export PATH="$HOME/tools:$PATH"\n',
    )
    for (const command of ['bun', 'uv', 'gh', 'pdftoppm']) {
      const tool = join(toolDir, command)
      writeFileSync(tool, '#!/bin/sh\nexit 0\n')
      chmodSync(tool, 0o755)
    }

    try {
      const path = await resolvePackagedSidecarPath(execPath, {
        HOME: home,
        SHELL: '/bin/zsh',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        CATCODE_TEST_SECRET: 'must-stay-in-parent',
      })
      expect(path.split(delimiter)[0]).toBe(bin)
      expect(existsSync(join(home, 'secret-exposed'))).toBe(false)
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          'command -v bun && command -v uv && command -v gh && command -v pdftoppm',
        ],
        { encoding: 'utf8', env: { PATH: path } },
      )
      expect(result.status).toBe(0)
      expect(result.stdout.trim().split('\n')).toEqual(
        ['bun', 'uv', 'gh', 'pdftoppm'].map(command => join(toolDir, command)),
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
