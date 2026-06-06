import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getAdditionalDirectoriesForClaudeMd,
  setAdditionalDirectoriesForClaudeMd,
} from '../../bootstrap/state.js'
import { getWatchablePaths } from './skillChangeDetector.js'

describe('getWatchablePaths', () => {
  let originalAdditionalDirs: string[]
  let tempRoot: string

  beforeEach(() => {
    originalAdditionalDirs = getAdditionalDirectoriesForClaudeMd()
    tempRoot = mkdtempSync(join(tmpdir(), 'skill-watch-'))
  })

  afterEach(() => {
    setAdditionalDirectoriesForClaudeMd(originalAdditionalDirs)
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('watches .cat-code/skills (not .claude/skills) for --add-dir directories', async () => {
    // Loader reads <dir>/.cat-code/skills, so the watcher must watch the same.
    const catCodeSkills = join(tempRoot, '.cat-code', 'skills')
    mkdirSync(catCodeSkills, { recursive: true })

    setAdditionalDirectoriesForClaudeMd([tempRoot])

    const paths = await getWatchablePaths()

    expect(paths).toContain(catCodeSkills)
    expect(paths).not.toContain(join(tempRoot, '.claude', 'skills'))
  })
})
