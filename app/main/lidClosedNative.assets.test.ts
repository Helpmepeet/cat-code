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
    const installed = join(directory, 'installed-helper')
    expect(await adapter.lidHelperCurrent(directory, installed)).toBe(false)
    writeFileSync(installed, 'previous helper')
    expect(await adapter.lidHelperCurrent(directory, installed)).toBe(false)
    writeFileSync(installed, originals.helper!)
    expect(await adapter.lidHelperCurrent(directory, installed)).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(await adapter.inspectLidHardware(directory)).toEqual(hardware)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    for (const name of Object.keys(originals)) {
      writeFileSync(join(directory, name), originals[name] + '\n# substituted\n')
      await expect(adapter.lidHelperCurrent(directory, installed)).rejects.toThrow('setup files changed')
      await expect(adapter.inspectLidHardware(directory)).rejects.toThrow('setup files changed')
      await expect(adapter.installLidHelper(directory)).rejects.toThrow('setup files changed')
      expect(existsSync(marker)).toBe(false)
      writeFileSync(join(directory, name), originals[name]!)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('administrator payload hashes stay pinned when account-owned staging is substituted', async () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-stage-')
  try {
    const hardware = { qualified: true, evidence: 'fixture', model: 'fixture', osBuild: 'fixture', safety: {} }
    const originals = { helper: 'sealed helper', 'install.sh': '__EXPECTED_PAYLOAD__', 'uninstall.sh': 'sealed removal' }
    for (const [name, bytes] of Object.entries(originals)) writeFileSync(join(directory, name), bytes)
    const pins = Object.fromEntries(Object.entries(originals).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]))
    const capture = join(directory, 'captured-installer')
    const fixture = join(directory, 'process.ts')
    // Substitute staging while the adapter awaits code-sign inspection. This
    // is an ordinary same-account write, before administrator authentication.
    writeFileSync(fixture, `import { readFileSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { promisify } from 'node:util';
      let prepared;
      export function spawn() { throw new Error('unexpected client'); }
      export function execFile() { throw new Error('use async execution'); }
      execFile[promisify.custom] = async (file, args) => {
        if (args[0] === '--hardware') return { stdout: ${JSON.stringify(JSON.stringify(hardware))}, stderr: '' };
        if (file === '/usr/bin/codesign') {
          prepared = dirname(args.at(-1));
          writeFileSync(join(prepared, 'uninstall.sh'), 'substituted root payload');
          return { stdout: '', stderr: 'CDHash=1111111111111111111111111111111111111111' };
        }
        if (file === '/usr/bin/osascript') {
          writeFileSync(${JSON.stringify(capture)}, readFileSync(join(prepared, 'install.sh')));
          return { stdout: '', stderr: '' };
        }
        throw new Error('unexpected child ' + file);
      };`)
    const built = await Bun.build({ entrypoints: [new URL('./lidClosedNative.ts', import.meta.url).pathname], target: 'bun',
      define: { __CATCODE_LID_ASSET_SHA256__: JSON.stringify(pins) },
      plugins: [{ name: 'administrator-boundary', setup(builder) {
        builder.onLoad({ filter: /lidClosedNative\.ts$/ }, args => ({ loader: 'ts',
          contents: readFileSync(args.path, 'utf8').replace("'node:child_process'", JSON.stringify(fixture)) }))
      } }] })
    expect(built.success).toBe(true)
    const output = join(directory, 'adapter.mjs')
    await Bun.write(output, built.outputs[0]!)
    const adapter = await import(pathToFileURL(output).href) as typeof import('./lidClosedNative.js')
    await adapter.installLidHelper(directory)
    const installer = readFileSync(capture, 'utf8')
    expect(installer).toContain(`${pins['uninstall.sh']}  uninstall.sh`)
    expect(installer).not.toContain(createHash('sha256').update('substituted root payload').digest('hex'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
