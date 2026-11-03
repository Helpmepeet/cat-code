import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('usage transport denies rejected and superseded authority revisions after deferred interceptors', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-authority-'))
  const source = (name: string) => new URL(name, import.meta.url).href
  const child = Bun.spawn([process.execPath, '-e', `
    import { expect, spyOn } from 'bun:test';
    import https from 'node:https';
    import { Readable, Writable } from 'node:stream';
    globalThis.MACRO = { VERSION: 'test' };
    const authority = await import(${JSON.stringify(source('./claudeAccountAuthority.ts'))});
    const { fetchUtilizationForToken, fetchUtilization } = await import(${JSON.stringify(source('./usage.ts'))});
    const auth = await import(${JSON.stringify(source('../../utils/auth.ts'))});
    const axios = (await import('axios')).default;
    let sends = 0;
    spyOn(https, 'request').mockImplementation((options, callback) => {
      sends++;
      const req = new Writable({ write(chunk, encoding, done) { done(); } });
      req.setTimeout = () => req;
      req.setNoDelay = () => req;
      req.setSocketKeepAlive = () => req;
      req.on('finish', () => {
        const res = Readable.from(['{}']);
        res.statusCode = 200; res.headers = {}; res.req = req; callback(res);
      });
      return req;
    });
    const tokens = accessToken => ({ accessToken, refreshToken: 'refresh', expiresAt: Date.now() + 3600000 });
    const login = authority.commitClaudeLogin('a', 'login-a', tokens('token-0'), { account_uuid: 'a', email_address: 'a@example.test' });
    expect(login.outcome).toBe('committed');
    const initial = login.handle;
    const credential = { accountUuid: 'a', lifecycleGeneration: initial.generation, credentialRevision: initial.revision };
    await fetchUtilizationForToken('token-0', credential);
    expect(sends).toBe(1);
    const rejectInterceptor = axios.interceptors.request.use(async config => {
      await Promise.resolve();
      expect(authority.rejectClaudeCredential(initial).outcome).toBe('committed');
      return config;
    });
    await expect(fetchUtilizationForToken('token-0', credential)).rejects.toThrow();
    expect(sends).toBe(1);
    axios.interceptors.request.eject(rejectInterceptor);
    spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true);
    spyOn(auth, 'hasProfileScope').mockReturnValue(true);
    const activeTokens = spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue({ ...tokens('token-0'), accountUuid: 'a' });
    expect(await fetchUtilization()).toBeNull();
    expect(sends).toBe(1);
    const relogin = authority.commitClaudeLogin('a', 'login-b', tokens('token-1'), { account_uuid: 'a', email_address: 'a@example.test' });
    expect(relogin.outcome).toBe('committed');
    const current = relogin.handle;
    const currentCredential = { accountUuid: 'a', lifecycleGeneration: current.generation, credentialRevision: current.revision };
    const rotateInterceptor = axios.interceptors.request.use(async config => {
      await Promise.resolve();
      const claim = authority.claimClaudeRefresh(current, 'refresh-a', 'owner-a').claim;
      expect(claim).toBeDefined();
      expect(authority.startClaudeRefreshDispatch(claim, () => true).result.outcome).toBe('committed');
      expect(authority.completeClaudeRefresh(claim, tokens('token-2')).outcome).toBe('committed');
      return config;
    });
    await expect(fetchUtilizationForToken('token-1', currentCredential)).rejects.toThrow();
    expect(sends).toBe(1);
    axios.interceptors.request.eject(rotateInterceptor);
    const successor = authority.readClaudeAccountAuthority('a');
    expect(successor.status).toBe('ready');
    await fetchUtilizationForToken('token-2', { accountUuid: 'a', lifecycleGeneration: successor.handle.generation, credentialRevision: successor.handle.revision });
    expect(sends).toBe(2);
    activeTokens.mockReturnValue({ ...tokens('token-2'), accountUuid: 'a' });
    await fetchUtilization();
    expect(sends).toBe(3);
    console.log('authority usage checks passed');
  `], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, 'config'), CODEX_HOME: join(home, 'codex'), HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' },
    stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain('authority usage checks passed')
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    rmSync(home, { recursive: true, force: true })
  }
})
