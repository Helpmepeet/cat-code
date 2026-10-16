import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLidHelper } from '../../scripts/build-lid-helper.js'

const macTest = process.platform === 'darwin' ? test : test.skip
macTest('native setup validates an explicit account grant and refuses old or malformed authority', () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-config-')
  try {
    buildLidHelper()
    const helper = new URL('./dist/helper', import.meta.url).pathname
    const path = join(directory, 'configuration.json')
    const valid = { version: 3, uid: process.getuid!(), access: 'account', bridgeRequirement: `cdhash H"${'01'.repeat(20)}"`, experimentUntil: 0 }
    const check = (value: object) => {
      writeFileSync(path, JSON.stringify(value))
      return spawnSync(helper, ['--check-configuration', path], { encoding: 'utf8', timeout: 5000 })
    }
    expect(check(valid).stdout.trim()).toBe('valid-configuration')
    expect(check({ ...valid, applicationTrialUntil: Date.now() / 1000 + 180 }).status).toBe(0)
    expect(check({ ...valid, access: 'experiment', experimentUntil: Date.now() / 1000 + 180 }).status).toBe(0)
    for (const change of [
      { version: 2 }, { uid: 0 }, { access: 'anyone' }, { bridgeRequirement: 'invalid requirement' },
      { experimentUntil: 100 }, { applicationTrialUntil: -1 },
      { access: 'experiment', experimentUntil: 100, applicationTrialUntil: 100 },
    ]) expect(check({ ...valid, ...change }).status).not.toBe(0)
    expect(spawnSync(helper, ['--check-native'], { encoding: 'utf8', timeout: 5000 }).status).toBe(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 70_000)
