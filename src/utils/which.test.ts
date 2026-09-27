import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { which, whichSync } from './which.js'

const originalPath = process.env.PATH
const roots: string[] = []

function toolDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'catcode-which-'))
  roots.push(root)
  const tool = join(root, name)
  writeFileSync(tool, '#!/bin/sh\nexit 0\n')
  chmodSync(tool, 0o755)
  return root
}

afterEach(() => {
  process.env.PATH = originalPath
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('which', () => {
  test('finds a command added to PATH after startup', async () => {
    const name = 'catcode-which-late-tool'
    const root = toolDir(name)
    process.env.PATH = [root, '/usr/bin', '/bin'].join(':')

    expect(whichSync(name)).toBe(join(root, name))
    expect(await which(name)).toBe(join(root, name))
  })

  test('stops finding a command removed from PATH after startup', async () => {
    process.env.PATH = toolDir('unrelated')

    expect(whichSync('sh')).toBeNull()
    expect(await which('sh')).toBeNull()
  })

  test('finds nothing when PATH is unset', () => {
    delete process.env.PATH

    expect(whichSync('sh')).toBeNull()
  })
})
