/** Reproducible diagnostic-write A/B benchmark. No running app or user data. */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const repo = resolve(import.meta.dir, '../../..')
const sourcePath = 'app/main/deliveryTraceSink.ts'
const revisions = {
  before: 'bbba34b31c5b700cdaa0cfe2edb3c9109898fdac',
  after: 'cdbb2fa183c8df3429f6bcd8e31e76d9948f975e',
}
const recordsPerSample = 50_000
const rounds = Number(process.env.BENCH_ROUNDS ?? 8)
const scratch = mkdtempSync(join(tmpdir(), 'cat-code-log-measurement-'))
const electron = join(repo, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const outputPath = resolve(process.argv[2] ?? join(import.meta.dir, 'logging-results.json'))
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

async function command(cmd: string[], env = process.env) {
  const child = Bun.spawn(cmd, { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${stderr}`)
  return stdout
}

try {
  const metadata: Record<string, unknown> = {
    timestamp: new Date().toISOString(), revisions, recordsPerSample, rounds,
    bun: Bun.version, platform: process.platform, arch: process.arch,
    head: (await command(['git', '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'])).trim(),
    note: 'Electron embedded Node, headless; timed diagnostic writes only; warm filesystem cache; no fsync or power measurement.',
  }
  const modules: Record<string, string> = {}
  for (const [variant, revision] of Object.entries(revisions)) {
    const original = await command(['git', '-c', 'core.fsmonitor=false', 'show', `${revision}:${sourcePath}`])
    const rewritten = original.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
      (_match, before, specifier, after) => before + resolve(repo, dirname(sourcePath), specifier) + after)
    const input = join(scratch, `${variant}.ts`)
    writeFileSync(input, rewritten)
    const built = await Bun.build({ entrypoints: [input], target: 'node', format: 'esm', minify: false })
    if (!built.success) throw new Error(built.logs.map(String).join('\n'))
    const bundle = await built.outputs[0]!.text()
    modules[variant] = join(scratch, `${variant}.mjs`)
    writeFileSync(modules[variant]!, bundle)
    metadata[`${variant}SourceSha256`] = sha(original)
    metadata[`${variant}BundleSha256`] = sha(bundle)
  }
  const worker = join(scratch, 'worker.mjs')
  writeFileSync(worker, `
    import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    const { createDeliveryTraceSink } = await import(process.argv[2]);
    function exercise(count) {
      const root = mkdtempSync(join(tmpdir(), 'cat-code-log-sample-'));
      try {
        const sink = createDeliveryTraceSink({ configDir: root, launchId: 'synthetic-launch', sweepIntervalMs: 0, now: () => new Date(1750000000000) });
        const cpu = process.cpuUsage(); const start = performance.now();
        for (let i = 1; i <= count; i++) sink.recordAcknowledgementRejected({ sessionId: 'synthetic-' + (i % 4), streamEpoch: 'synthetic-stream', sequence: Math.ceil(i / 4), reason: 'stale_document' });
        sink.close();
        const wallMs = performance.now() - start;
        const elapsedCpu = process.cpuUsage(cpu);
        const files = readdirSync(join(root, 'logs')).filter(f => f.startsWith('delivery-trace-') && f.endsWith('.jsonl'));
        const records = files.flatMap(f => readFileSync(join(root, 'logs', f), 'utf8').trim().split('\\n').map(JSON.parse));
        if (records.length !== count) throw new Error('record count changed: ' + records.length);
        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (r.recordKind !== 'trace.ack.rejected' || r.schemaVersion !== 1 || r.sessionId !== 'synthetic-' + ((i + 1) % 4) || r.streamEpoch !== 'synthetic-stream' || r.sequence !== Math.ceil((i + 1) / 4) || r.reason !== 'stale_document') throw new Error('diagnostic event content changed');
        }
        const checksum = createHash('sha256').update(JSON.stringify(records.map(r => [r.recordKind, r.schemaVersion, r.sessionId, r.streamEpoch, r.sequence, r.reason]))).digest('hex');
        return { wallMs, cpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000, userCpuMs: elapsedCpu.user / 1000, systemCpuMs: elapsedCpu.system / 1000, recordCount: records.length, checksum, node: process.version, electron: process.versions.electron };
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    exercise(2000);
    global.gc?.();
    console.log(JSON.stringify(exercise(Number(process.argv[3]))));
  `)
  const samples: unknown[] = []
  let expectedChecksum: string | undefined
  for (let round = 0; round < rounds; round++) {
    for (const variant of round % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
      const value = JSON.parse(await command([electron, '--expose-gc', worker, modules[variant]!, String(recordsPerSample)], {
        PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', HOME: scratch, CLAUDE_CONFIG_DIR: scratch,
      }))
      expectedChecksum ??= value.checksum
      if (value.checksum !== expectedChecksum) throw new Error('Before/after record output differs')
      samples.push({ round, variant, ...value })
      process.stderr.write(`logging ${round + 1}/${rounds} ${variant}: CPU ${value.cpuMs.toFixed(1)} ms, elapsed ${value.wallMs.toFixed(1)} ms\n`)
    }
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify({ metadata, samples }, null, 2) + '\n')
  console.log(outputPath)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
