import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('sealed setup hashes reject substituted assets before executing or requesting authorization', async () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-assets-')
  try {
    const marker = join(directory, 'executed')
    const hardware = { qualified: true, evidence: 'fixture', model: 'fixture', osBuild: 'fixture', safety: { thermal: 'nominal' } }
    const originals: Record<string, string> = {
      helper: `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\n' '${JSON.stringify(hardware)}'\n`,
      'install.sh': '#!/bin/sh\nexit 99\n',
      'uninstall.sh': '#!/bin/sh\nexit 99\n',
    }
    for (const [name, bytes] of Object.entries(originals)) writeFileSync(join(directory, name), bytes)
    chmodSync(join(directory, 'helper'), 0o700)
    const pins = Object.fromEntries(Object.keys(originals).map(name => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]))
    const output = join(directory, 'adapter.mjs')
    const built = await Bun.build({ entrypoints: [new URL('./lidClosedNative.ts', import.meta.url).pathname], target: 'bun',
      define: { __CATCODE_LID_ASSET_SHA256__: JSON.stringify(pins) } })
    expect(built.success).toBe(true)
    await Bun.write(output, built.outputs[0]!)
    const adapter = await import(pathToFileURL(output).href) as typeof import('./lidClosedNative.js')
    expect(await adapter.inspectLidHardware(directory)).toEqual(hardware)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    for (const name of Object.keys(originals)) {
      writeFileSync(join(directory, name), originals[name] + '\n# substituted\n')
      await expect(adapter.inspectLidHardware(directory)).rejects.toThrow('setup files changed')
      await expect(adapter.installLidHelper(directory, '/unqualified.app/Contents/MacOS/fixture')).rejects.toThrow('setup files changed')
      expect(existsSync(marker)).toBe(false)
      writeFileSync(join(directory, name), originals[name]!)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
