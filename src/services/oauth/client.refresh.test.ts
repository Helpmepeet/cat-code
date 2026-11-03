import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('refresh transport captures successors without enrichment and gates initiation synchronously', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-refresh-transport-'))
  const path = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href)
  const child = Bun.spawn([process.execPath, '-e', `
    import { mock, spyOn, expect } from 'bun:test';
    import http from 'node:http';
    import https from 'node:https';
    import { Writable, Readable } from 'node:stream';
    let sends = 0, profiles = 0, writes = 0;
    const transportFailure = new Error('response lost');
    let fail = false;
    const physical = (options, callback) => {
      sends++;
      const req = new Writable({ write(chunk, encoding, done) { done(); } });
      req.setTimeout = () => req;
      req.setNoDelay = () => req;
      req.setSocketKeepAlive = () => req;
      req.on('finish', () => {
        if (fail) { req.destroy(transportFailure); return; }
        const response = Readable.from([JSON.stringify({ access_token: 'successor', refresh_token: 'rotated', expires_in: 3600, scope: 'user:inference' })]);
        response.statusCode = 200; response.headers = {}; response.req = req;
        callback(response);
      });
      return req;
    };
    spyOn(http, 'request').mockImplementation(physical);
    spyOn(https, 'request').mockImplementation(physical);
    mock.module(${path('../../utils/auth.ts')}, () => ({
      getClaudeAIOAuthTokens: () => ({ refreshToken: 'old', subscriptionType: 'pro', rateLimitTier: 'tier' }),
      getOauthAccountInfo: () => ({ accountUuid: 'a' }),
      checkAndRefreshOAuthTokenIfNeeded: () => {}, hasProfileScope: () => true,
      isClaudeAISubscriber: () => true, saveApiKey: () => {},
    }));
    mock.module(${path('../api/claudeAccountPool.ts')}, () => ({ updateClaudeAccountRoles: () => {} }));
    mock.module(${path('../analytics/index.ts')}, () => ({ logEvent: () => {} }));
    mock.module(${path('../../utils/config.ts')}, () => ({ getGlobalConfig: () => ({}), saveGlobalConfig: () => { writes++; } }));
    mock.module(${path('../../utils/debug.ts')}, () => ({ logForDebugging: () => {} }));
    mock.module(${path('./getOauthProfile.ts')}, () => ({ getOauthProfileFromOauthToken: async () => { profiles++; throw new Error('profile unavailable'); } }));
    const { refreshOAuthToken } = await import(${path('./client.ts')});
    let boundary = false;
    const result = await refreshOAuthToken('old', { skipProfile: true, initiateRequest: start => {
      boundary = true;
      const request = start();
      expect(sends).toBe(1);
      boundary = false;
      return request;
    } });
    expect(boundary).toBe(false);
    expect(result.accessToken).toBe('successor');
    expect(result.refreshToken).toBe('rotated');
    expect(result.subscriptionType).toBe('pro');
    expect(profiles).toBe(0); expect(writes).toBe(0);
    const denied = new Error('older login');
    await expect(refreshOAuthToken('old', { initiateRequest: () => { throw denied; } })).rejects.toBe(denied);
    expect(sends).toBe(1);
    let lateStart;
    await expect(refreshOAuthToken('old', { initiateRequest: start => {
      lateStart = start; return Promise.resolve({});
    } })).rejects.toThrow('did not synchronously start');
    expect(() => lateStart()).toThrow('synchronously and exactly once');
    expect(sends).toBe(1);
    const axios = (await import('axios')).default;
    let authorized = true;
    const interceptor = axios.interceptors.request.use(async config => {
      await Promise.resolve();
      authorized = false;
      return config;
    });
    await expect(refreshOAuthToken('old', { skipProfile: true, initiateRequest: start => {
      if (!authorized) throw denied;
      return start();
    } })).rejects.toBe(denied);
    expect(sends).toBe(1);
    axios.interceptors.request.eject(interceptor);
    fail = true;
    await expect(refreshOAuthToken('old', { skipProfile: true })).rejects.toMatchObject({ message: 'response lost' });
    expect(sends).toBe(2);
    expect(profiles).toBe(0);
  `], {
    env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config') },
    stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' })
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})
