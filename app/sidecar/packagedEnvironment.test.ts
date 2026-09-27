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
  appendPackagedBinToPath,
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

  test('puts the companion bin after user tools and does not duplicate it', () => {
    expect(
      appendPackagedBinToPath(
        execPath,
        ['/usr/bin', bin, '/bin'].join(delimiter),
      ),
    ).toBe(['/usr/bin', '/bin', bin].join(delimiter))
  })

  test('constructs a usable PATH when the parent has none', () => {
    expect(appendPackagedBinToPath(execPath, undefined)).toBe(bin)
  })

  test('finds user tools when a packaged app starts with only the GUI PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'catcode-packaged-path-'))
    const toolDir = join(home, 'tools')
    const zdotdir = join(home, 'zsh')
    mkdirSync(zdotdir)
    mkdirSync(toolDir)
    writeFileSync(join(home, '.zprofile'), 'printf "shell startup message\\n"\n')
    writeFileSync(
      join(home, '.zshrc'),
      'export PATH="$HOME/wrong-rc:$PATH"\n',
    )
    writeFileSync(
      join(zdotdir, '.zshrc'),
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
        ZDOTDIR: zdotdir,
        SHELL: '/bin/zsh',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        CATCODE_TEST_SECRET: 'must-stay-in-parent',
      })
      expect(path.split(delimiter)[0]).toBe(toolDir)
      expect(path.split(delimiter).at(-1)).toBe(bin)
      expect(path).not.toContain(join(home, 'wrong-rc'))
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

  test('user rg wins while the companion remains available when no user rg exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'catcode-packaged-rg-'))
    const userBin = join(root, 'user')
    const resources = join(root, 'Resources')
    const companionBin = join(resources, 'bin')
    const sidecarDir = join(resources, 'sidecar')
    mkdirSync(userBin)
    mkdirSync(companionBin, { recursive: true })
    mkdirSync(sidecarDir)
    const bundledRg = join(companionBin, 'rg')
    const userRg = join(userBin, 'rg')
    for (const [file, text] of [[bundledRg, 'companion'], [userRg, 'user']]) {
      writeFileSync(file, `#!/bin/sh\nprintf '${text}\\n'\n`)
      chmodSync(file, 0o755)
    }
    const executable = join(sidecarDir, 'cat-code-sidecar')
    try {
      for (const [initialPath, expected] of [
        [userBin, 'user'],
        [join(root, 'empty'), 'companion'],
      ]) {
        const path = appendPackagedBinToPath(executable, initialPath)
        const result = spawnSync('/bin/sh', ['-c', 'rg'], {
          encoding: 'utf8',
          env: { PATH: path },
        })
        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe(expected)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
