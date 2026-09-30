/** Isolated logical-write probe. Run: bun scripts/measure-disk-writes.ts */
import { Database } from 'bun:sqlite';
import { spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectIndexedUsage } from '../src/utils/statsUsageIndex.js';
import { createDeliveryTraceSink } from '../app/main/deliveryTraceSink.js';
import { mintDeliveryTrace, type DeliveryStage } from '../app/shared/deliveryTrace.js';
import { createOperationalLogSink } from '../app/main/operationalLogSink.js';
import { createOperationalRecord } from '../app/shared/operationalLog.js';

const root = fs.mkdtempSync(join(tmpdir(), 'cat-write-probe-'));
const result: Record<string, unknown> = { accounting: 'logical JSONL append bytes; SQLite changed rows and serialized WAL frames before close (not SSD bytes)' };
try {
  const stages: DeliveryStage[] = ['engine.produced', 'sidecar.socket.sent', 'supervisor.socket.received', 'host.received', 'main.ipc.sent', 'preload.received', 'renderer.state.applied'];
  let clock = 0;
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'measurement', sweepIntervalMs: 0,
    now: () => new Date(Date.parse('2026-09-30T00:00:00Z') + clock), monotonicNow: () => clock });
  const writes: Record<string, { records: number; bytes: number }> = {};
  const originalWrite = fs.writeSync;
  const writeSpy = spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
    const record = JSON.parse(data);
    const lane = writes[record.recordKind ?? record.event] ??= { records: 0, bytes: 0 };
    lane.records++; lane.bytes += Buffer.byteLength(data);
    return originalWrite(fd, data);
  }) as typeof fs.writeSync);
  const framesPerSecond = process.argv.includes('--normal') ? 2 : 20;
  const frames = framesPerSecond * 600;
  for (let sequence = 1; sequence <= frames; sequence++) {
    clock = sequence * 1000 / framesPerSecond; // Ten minutes, seven marks per frame.
    const trace = mintDeliveryTrace(sequence, 'stream', 'sidecar', () => new Date(clock));
    for (const stage of stages) sink.mark({ sessionId: 'session', trace, stage, frameKind: 'event', messageKind: 'stream_event' });
    if (sequence % (framesPerSecond * 60) === 0) sink.emitStreamRollups();
  }
  sink.close();
  result.delivery = { frames, seconds: clock / 1000, writes: structuredClone(writes), bytesPerFrame: Object.values(writes).reduce((sum, row) => sum + row.bytes, 0) / frames,
    MBPerHour: Object.values(writes).reduce((sum, row) => sum + row.bytes, 0) * 6 / 1e6 };
  const ops = createOperationalLogSink({ configDir: root, now: () => new Date(clock) });
  for (let turn = 0; turn < 100; turn++) {
    clock += 6000;
    ops.write({ level: 'info', process: 'main', event: 'session.turn.started', appSessionId: 'session' });
    ops.writeRecord(createOperationalRecord({ level: 'info', process: 'sidecar', event: 'session.turn.completed', appSessionId: 'session' },
      { launchId: 'measurement', processInstanceId: 'sidecar', processStartedAt: new Date(0).toISOString(), now: () => new Date(clock) }));
  }
  ops.close();
  result.operational = { turns: 100, seconds: 600, writes: Object.fromEntries(Object.entries(writes).filter(([key]) => key.startsWith('session.'))) };
  writeSpy.mockRestore();

  const file = join(root, 'session.jsonl'), path = join(root, 'index.sqlite');
  const row = (id: number) => JSON.stringify({ type: 'assistant', sessionId: 's', uuid: String(id), timestamp: '2026-09-29T12:00:00Z',
    message: { id: String(id), model: 'model', usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: 'synthetic '.repeat(100) }] } }) + '\n';
  fs.writeFileSync(file, Array.from({ length: 50000 }, (_, id) => row(id)).join(''));
  const sourceBytes = fs.statSync(file).size;
  const counters = () => ({ sourceBytesRead: 0, rowsInserted: 0, rowsDeleted: 0, identityWrites: 0, durableIdentityWrites: 0, walBytes: 0, shmRetainedBytes: 0 });
  let measured = counters();
  const originalOpen = fsp.open;
  const openSpy = spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: unknown[]) => {
        const value = await (read as Function)(...readArgs);
        measured.sourceBytesRead += value.bytesRead;
        return value;
      }) as typeof handle.read;
    }
    return handle;
  }) as typeof fsp.open);
  const query = Database.prototype.query;
  const querySpy = spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, sql: string) {
    const statement = query.call(this, sql);
    const run = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => {
      const value = (run as Function)(...args);
      if (/^INSERT INTO records/i.test(sql)) measured.rowsInserted += value.changes;
      if (/^DELETE FROM records/i.test(sql)) measured.rowsDeleted += value.changes;
      if (/^INSERT OR REPLACE INTO identities/i.test(sql)) {
        measured.identityWrites += value.changes;
        if (this.filename !== ':memory:') measured.durableIdentityWrites += value.changes;
      }
      return value;
    }) as typeof statement.run;
    return statement;
  } as typeof Database.prototype.query);
  const close = Database.prototype.close;
  const closeSpy = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database) {
    if (this.filename === path) {
      for (const [suffix, key] of [['-wal', 'walBytes'], ['-shm', 'shmRetainedBytes']] as const) {
        try { measured[key] = fs.statSync(path + suffix).size; } catch {}
      }
    }
    return close.call(this);
  });
  const rounds = [];
  for (let round = 0; round < 4; round++) {
    if (round) fs.appendFileSync(file, row(50000 + round));
    measured = counters();
    const start = performance.now();
    await collectIndexedUsage([file], '2026-09-30T12:00:00Z', { path, deadline: Date.now() + 120000 });
    rounds.push({ round, ...measured, elapsedMs: Math.round(performance.now() - start), databaseRetainedBytes: fs.statSync(path).size });
  }
  closeSpy.mockRestore(); querySpy.mockRestore(); openSpy.mockRestore();
  result.analytics = { sourceBytes, existingRecords: 50000, appendRecordsPerRound: 1, rounds };
  // Exercise the real MCP sink with its filesystem append boundary captured;
  // no MCP server, accounts, network, or user's cache is touched.
  process.env.DEBUG = '0'; process.env.DEBUG_SDK = '0'; process.env.USER_TYPE = 'external';
  const { clearDebugModeCache, isDebugMode } = await import('../src/utils/debug.js');
  clearDebugModeCache();
  if (isDebugMode()) throw new Error('MCP probe requires normal debug logging disabled');
  const { getFsImplementation, setFsImplementation } = await import('../src/utils/fsOperations.js');
  const originalFs = getFsImplementation();
  let mcpRecords = 0, mcpBytes = 0, largestRecordBytes = 0;
  setFsImplementation({ ...originalFs, mkdirSync() {}, appendFileSync(_path, data) {
    for (const line of data.trimEnd().split('\n')) {
      const bytes = Buffer.byteLength(line) + 1;
      mcpRecords++; mcpBytes += bytes; largestRecordBytes = Math.max(largestRecordBytes, bytes);
    }
  } });
  try {
    const { initializeErrorLogSink, _flushLogWritersForTesting, _clearLogWritersForTesting } = await import('../src/utils/errorLogSink.js');
    const { logMCPDebug } = await import('../src/utils/log.js');
    initializeErrorLogSink();
    for (let message = 0; message < 6000; message++) logMCPDebug('synthetic', 'controlled routine diagnostic ' + message);
    _flushLogWritersForTesting(); _clearLogWritersForTesting();
    result.mcp = { debugEnabled: false, messages: 6000, seconds: 600, records: mcpRecords, bytes: mcpBytes, largestRecordBytes, MBPerHour: mcpBytes * 6 / 1e6 };
  } finally { setFsImplementation(originalFs); }
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes('--assert')) {
    for (const round of rounds.slice(1)) {
      if (round.rowsInserted !== 1 || round.rowsDeleted !== 0 || round.durableIdentityWrites !== 0 || round.walBytes > 1024 * 1024)
        throw new Error('Analytics append write budget exceeded');
    }
    const losses = writes['trace.loss'];
    if ((losses?.records ?? 0) > 10 || (losses?.bytes ?? 0) > 8192)
      throw new Error('Delivery ring-eviction write budget exceeded');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
