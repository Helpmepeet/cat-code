import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseLidNativeReply } from './lidClosedNative.js'

const identity = '0b8b8c9d-4e6f-4a51-9e1a-2b3c4d5e6f70'
function workSnapshot(record: Record<string, unknown>) {
  return { record: { phase: 'active', began: 1, deadline: 2, allowance: 10, needsRestore: true,
    sleepRequested: false, sleepRequestAttempted: false, ...record },
    safety: { sleepDisabled: true, lidClosed: false, thermal: 'nominal' },
    remainingSeconds: 1, hardwareQualified: true }
}

test('native decoder preserves v1 success without pretending it is a v2 work receipt', () => {
  const decoded = parseLidNativeReply({ ok: true, snapshot: workSnapshot({ version: 1, identity }) })
  expect(decoded.ok).toBe(true)
  expect(decoded.snapshot?.record.version).toBe(1)
  expect(decoded.snapshot?.record.mode).toBeUndefined()
})

test('native decoder accepts v2 work snapshots and rejects incomplete v2 receipts', () => {
  const good = parseLidNativeReply({ ok: true, snapshot: workSnapshot({
    version: 2, mode: 'work', renewalSequence: 4, identity,
  }) })
  expect(good.ok).toBe(true)
  expect(good.snapshot?.record).toMatchObject({ version: 2, mode: 'work', renewalSequence: 4 })
  expect(() => parseLidNativeReply({ ok: true, snapshot: workSnapshot({ version: 2, identity }) })).toThrow()
  expect(() => parseLidNativeReply({ ok: true, snapshot: workSnapshot({ version: 2, mode: 'work', renewalSequence: 1.5, identity }) })).toThrow()
})

// Real bridge processes and stdin/stdout, with only the fixed executable path
// relocated in this test bundle. No root helper or service is installed.
test('an unavailable XPC generation is discarded before the next native request', async () => {
  const directory = mkdtempSync('/private/tmp/cat-lid-connection-')
  let client: import('./lidClosedNative.js').LidNativeClient | undefined
  try {
    const counter = join(directory, 'connections')
    const helper = join(directory, 'bridge')
    const snapshot = { record: { version: 1, phase: 'off', began: 0, deadline: 0, allowance: 0,
      needsRestore: false, sleepRequested: false, sleepRequestAttempted: false },
      safety: { sleepDisabled: false, lidClosed: false, thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true }
    writeFileSync(helper, `#!${process.execPath}
      import { existsSync, writeFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const stale = !existsSync(${JSON.stringify(counter)});
      writeFileSync(${JSON.stringify(counter)}, 'connected');
      createInterface({ input: process.stdin }).on('line', () => {
        console.log(JSON.stringify(stale ? { ok: false, error: 'helper-unavailable' } : ${JSON.stringify({ ok: true, snapshot })}));
      });`)
    chmodSync(helper, 0o700)
    const built = await Bun.build({ entrypoints: [new URL('./lidClosedNative.ts', import.meta.url).pathname], target: 'bun',
      plugins: [{ name: 'fixed-bridge-fixture', setup(builder) {
        builder.onLoad({ filter: /lidClosedNative\.ts$/ }, args => ({ loader: 'ts', contents:
          readFileSync(args.path, 'utf8').replace("'/Library/PrivilegedHelperTools/com.catcode.lid-closed'", JSON.stringify(helper)) }))
      } }] })
    expect(built.success).toBe(true)
    const output = join(directory, 'adapter.mjs')
    await Bun.write(output, built.outputs[0]!)
    const adapter = await import(pathToFileURL(output).href) as typeof import('./lidClosedNative.js')
    client = new adapter.LidNativeClient()
    expect((await client.command({ op: 'status' })).ok).toBe(false)
    expect((await client.command({ op: 'status' })).snapshot?.safety.sleepDisabled).toBe(false)
  } finally { client?.close(); rmSync(directory, { recursive: true, force: true }) }
})
