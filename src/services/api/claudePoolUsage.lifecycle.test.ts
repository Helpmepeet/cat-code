import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('real pool usage fences physical sends across lifecycle changes and deferred interceptors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-lifecycle-'))
  const modulePath = new URL('./claudePoolUsage.ts', import.meta.url).href
  const securePath = new URL('../../utils/secureStorage/index.ts', import.meta.url).href
  const lockPath = new URL('../../utils/lockfile.ts', import.meta.url).href
  const child = Bun.spawn([process.execPath, '-e', `
    import { mock, spyOn, expect } from 'bun:test';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import http from 'node:http';
    import https from 'node:https';
    import { Writable, Readable } from 'node:stream';
    globalThis.MACRO = { VERSION: 'test' };
    mock.module(${JSON.stringify(securePath)}, () => ({
      getSecureStorage: () => { throw new Error('unexpected secure storage'); },
      removeMatchingClaudeOAuthCredentials: () => { throw new Error('unexpected secure storage'); },
    }));
    const { fetchClaudePoolUsage } = await import(${JSON.stringify(modulePath)});
    const routing = await import(${JSON.stringify(new URL('./sessionAccountRouting.ts', import.meta.url).href)});
    routing.blockSessionAccountRoute('anthropic', 'deleted-session-account');
    const axios = (await import('axios')).default;
    const locks = await import(${JSON.stringify(lockPath)});
    const root = process.env.HOME;
    const vault = join(root, 'claude-vault/accounts');
    mkdirSync(vault, { recursive: true });
    const file = join(vault, 'a.json');
    let sends = 0;
    let cleanupFailure = false;
    const acquire = locks.acquireMutationLockSync;
    spyOn(locks, 'acquireMutationLockSync').mockImplementation((...args) => {
      const release = acquire(...args);
      return () => { release(); if (cleanupFailure) throw new Error('unlock failed'); };
    });
    const physical = (options, callback) => {
      sends++;
      expect(options.headers.Authorization).toBe('Bearer old-token');
      const req = new Writable({ write(chunk, encoding, done) { done(); } });
      req.setTimeout = () => req;
      req.setNoDelay = () => req;
      req.setSocketKeepAlive = () => req;
      req.on('finish', () => {
        const res = Readable.from([JSON.stringify({ five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3600000).toISOString() } })]);
        res.statusCode = 200;
        res.headers = {};
        res.req = req;
        callback(res);
      });
      return req;
    };
    spyOn(https, 'request').mockImplementation(physical);
    spyOn(http, 'request').mockImplementation(physical);
    const account = { accountUuid: 'a', emailAddress: 'a@example.test', accessToken: 'old-token', refreshToken: 'unused', expiresAt: Date.now() + 3600000, status: 'healthy' };
    let sequence = 0;
    const poll = () => fetchClaudePoolUsage([account], { cacheFile: join(root, 'cache-' + sequence++ + '.json') });
    const lifecycle = (generation, deleted = false) => writeFileSync(file + '.lifecycle', JSON.stringify({ generation, deleted }));
    const vaultToken = (generation) => writeFileSync(file, JSON.stringify({ lifecycle_generation: generation, tokens: { access_token: 'new-token' } }));
    // Valid legacy inventory, including inactive accounts, still polls.
    writeFileSync(file, JSON.stringify({ tokens: { access_token: 'old-token' } }));
    expect((await poll()).get('a').fiveHour.percent).toBe(23);
    expect(sends).toBe(1);
    lifecycle(1, true);
    await poll();
    expect(sends).toBe(1);
    lifecycle(2); vaultToken(2);
    await poll();
    expect(sends).toBe(1);
    // An explicit old generation must not be relabelled with current storage.
    account.lifecycleGeneration = 1;
    await poll();
    expect(sends).toBe(1);
    account.lifecycleGeneration = 2;
    writeFileSync(file + '.lifecycle', 'corrupt');
    await poll();
    expect(sends).toBe(1);
    lifecycle(2);
    const interceptor = axios.interceptors.request.use(async config => {
      await Promise.resolve();
      lifecycle(3, true);
      return config;
    });
    await poll();
    expect(sends).toBe(1);
    axios.interceptors.request.eject(interceptor);
    // Adapter entry is also too early: defer before the built-in adapter.
    lifecycle(2);
    const adapter = axios.getAdapter('http');
    const deferred = axios.interceptors.request.use(config => {
      config.adapter = async config => {
        await Promise.resolve();
        lifecycle(3, true);
        return adapter(config);
      };
      return config;
    });
    await poll();
    expect(sends).toBe(1);
    axios.interceptors.request.eject(deferred);
    lifecycle(2);
    writeFileSync(file, JSON.stringify({ lifecycle_generation: 2, tokens: { access_token: 'old-token' } }));
    cleanupFailure = true;
    expect((await poll()).get('a').fiveHour.percent).toBe(23);
    expect(sends).toBe(2);
    console.log('lifecycle checks passed');
  `], {
    env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), CODEX_HOME: join(dir, 'codex'), HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' },
    stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain('lifecycle checks passed')
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    rmSync(dir, { recursive: true, force: true })
  }
})
