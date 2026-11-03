import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = (name: string) => new URL(name, import.meta.url).href
async function probe(body: string) {
  const home = mkdtempSync(join(tmpdir(), 'claude-auth-boundary-'))
  const child = Bun.spawn([process.execPath, '-e', `
    import { expect, spyOn } from 'bun:test';
    globalThis.MACRO = { VERSION: 'test' };
    const authority = await import(${JSON.stringify(source('./claudeAccountAuthority.ts'))});
    const pool = await import(${JSON.stringify(source('./claudeAccountPool.ts'))});
    const auth = await import(${JSON.stringify(source('../../utils/auth.ts'))});
    const debug = await import(${JSON.stringify(source('../../utils/debug.ts'))});
    const providers = await import(${JSON.stringify(source('../../utils/model/providers.ts'))});
    const config = await import(${JSON.stringify(source('../../utils/config.ts'))});
    config.enableConfigs();
    spyOn(debug, 'logForDebugging').mockImplementation(() => {});
    spyOn(providers, 'getAPIProvider').mockReturnValue('firstParty');
    spyOn(providers, 'isFirstPartyAnthropicBaseUrl').mockReturnValue(true);
    spyOn(auth, 'isAnthropicAuthEnabled').mockReturnValue(true);
    const keySource = spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({ key: null, source: 'none' });
    const credentials = token => ({ accessToken: token, refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scopes: ['user:inference'], subscriptionType: 'team' });
    const login = authority.commitClaudeLogin('a', 'login-a', credentials('initial'), { account_uuid: 'a', email_address: 'a@example.test' });
    expect(login.outcome).toBe('committed');
    pool.seedClaudeAccountPoolForTest({ activeAccountUuid: 'a', accounts: [{ ...credentials('initial'), accountUuid: 'a', emailAddress: 'a@example.test', lifecycleGeneration: login.handle.generation, credentialRevision: login.handle.revision, status: 'healthy' }] });
    ${body}
    console.log('boundary checks passed');
  `], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, 'config'), CODEX_HOME: join(home, 'codex'), HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '' },
    stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain('boundary checks passed')
  } finally {
    if (child.exitCode === null) child.kill()
    rmSync(home, { recursive: true, force: true })
  }
}

test('production client repairs a selected rejected access token when connectivity returns', async () => {
  await probe(`
    const oauth = await import(${JSON.stringify(source('../oauth/client.ts'))});
    const { APIError } = await import('@anthropic-ai/sdk');
    const { getAnthropicClient } = await import(${JSON.stringify(source('./client.ts'))});
    const { withRetry } = await import(${JSON.stringify(source('./withRetry.ts'))});
    let online = false, refreshes = 0;
    spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) => options.initiateRequest(async () => {
      refreshes++;
      if (!online) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
      return credentials('successor');
    }));
    const create = () => getAnthropicClient({ maxRetries: 0, provider: 'firstParty', model: 'claude-sonnet-4-6' });
    const initial = await create();
    expect(initial.authToken).toBe('initial');
    let rejected = false;
    try {
      for await (const row of withRetry(create, async () => { throw new APIError(401, {}, 'Unauthorized', new Headers({ 'x-should-retry': 'false' })); }, { maxRetries: 0, model: 'claude-sonnet-4-6', thinkingConfig: { type: 'disabled' }, isClaudeOAuthRequest: true })) {}
    } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(refreshes).toBe(2);
    expect(authority.readClaudeAccountAuthority('a').record.rejection).toBe('access_rejected');
    expect(auth.getClaudeAIOAuthTokens()).toBeNull();
    expect(auth.isClaudeAISubscriber()).toBe(false);
    const explicit = await getAnthropicClient({ maxRetries: 0, provider: 'firstParty', apiKey: 'explicit-key' });
    expect(explicit.apiKey).toBe('explicit-key');
    keySource.mockReturnValue({ key: 'environment-key', source: 'ANTHROPIC_API_KEY' });
    const apiKeyClient = await create();
    expect(apiKeyClient.apiKey).toBe('environment-key');
    expect(refreshes).toBe(2);
    keySource.mockReturnValue({ key: null, source: 'none' });
    online = true;
    const repaired = await create();
    expect(repaired.authToken).toBe('successor');
    expect(refreshes).toBe(3);
  `)
}, 15000)

test('production client prepares expired and rejected stored OAuth despite a retained managed Console key', async () => {
  await probe(`
    const oauth = await import(${JSON.stringify(source('../oauth/client.ts'))});
    const { getAnthropicClient } = await import(${JSON.stringify(source('./client.ts'))});
    keySource.mockReturnValue({ key: 'old-console-key', source: '/login managed key' });
    const expired = { ...credentials('expired'), expiresAt: 0 };
    const installed = authority.commitClaudeLogin('a', 'expired-login', expired, { account_uuid: 'a' });
    pool.seedClaudeAccountPoolForTest({ activeAccountUuid: 'a', accounts: [{ ...expired, accountUuid: 'a', emailAddress: 'a@example.test', lifecycleGeneration: installed.handle.generation, credentialRevision: installed.handle.revision, status: 'healthy' }] });
    auth.clearOAuthTokenCache();
    let refreshes = 0;
    spyOn(oauth, 'refreshOAuthToken').mockImplementation(async (_token, options) => options.initiateRequest(async () => {
      refreshes++;
      return credentials('successor-' + refreshes);
    }));
    const create = () => getAnthropicClient({ maxRetries: 0, provider: 'firstParty', model: 'claude-sonnet-4-6' });
    expect(auth.isClaudeAISubscriber()).toBe(true);
    const fresh = await create();
    expect(fresh.authToken).toBe('successor-1');
    expect(fresh.apiKey).toBeNull();
    expect(refreshes).toBe(1);
    const current = authority.readClaudeAccountAuthority('a');
    expect(authority.rejectClaudeCredential(current.handle, 'reject-access', 'access_rejected').outcome).toBe('committed');
    auth.clearOAuthTokenCache();
    expect(auth.getClaudeAIOAuthTokens()).toBeNull();
    const repaired = await create();
    expect(repaired.authToken).toBe('successor-2');
    expect(repaired.apiKey).toBeNull();
    expect(refreshes).toBe(2);
    const explicit = await getAnthropicClient({ maxRetries: 0, provider: 'firstParty', apiKey: 'explicit-key' });
    expect(explicit.apiKey).toBe('explicit-key');
    expect(refreshes).toBe(2);
  `)
}, 15000)

for (const service of ['policyLimits', 'remoteManagedSettings'] as const) {
  test(service + ' fences physical requests after deferred interceptors', async () => {
    await probe(`
      import https from 'node:https';
      import { Readable, Writable } from 'node:stream';
      const axios = (await import('axios')).default;
      const sleep = await import(${JSON.stringify(source('../../utils/sleep.ts'))});
      spyOn(sleep, 'sleep').mockResolvedValue(undefined);
      spyOn(auth, 'getAuthTokenSource').mockReturnValue({ source: 'none', hasToken: false });
      spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue(null);
      const service = await import(${JSON.stringify(source('../' + service + '/index.ts'))});
      const load = service.${service === 'policyLimits' ? 'loadPolicyLimits' : 'loadRemoteManagedSettings'};
      let sends = 0;
      spyOn(https, 'request').mockImplementation((options, callback) => {
        sends++;
        const req = new Writable({ write(chunk, encoding, done) { done(); } });
        req.setTimeout = () => req; req.setNoDelay = () => req; req.setSocketKeepAlive = () => req;
        req.on('finish', () => { const res = Readable.from([]); res.statusCode = 304; res.headers = {}; res.req = req; callback(res); });
        return req;
      });
      let current = login.handle;
      spyOn(auth, 'prepareClaudeOAuthRequest').mockImplementation(async () => ({ status: 'ready', handle: current, credentials: credentials('initial') }));
      await load();
      service.stopBackgroundPolling();
      expect(sends).toBe(1);
      for (const mutation of ['delete', 'relogin', 'reject']) {
        const installed = authority.commitClaudeLogin('a', 'login-' + mutation, credentials('initial'), { account_uuid: 'a' });
        current = installed.handle;
        let mutated = false;
        const interceptor = axios.interceptors.request.use(async config => {
          await Promise.resolve();
          expect(config.maxRedirects).toBe(0);
          expect(config.adapter).toBe('http');
          if (!mutated) {
            mutated = true;
            if (mutation === 'delete') authority.deleteClaudeAccountAuthority(current);
            else if (mutation === 'relogin') authority.commitClaudeLogin('a', 'successor-login', credentials('new-login'), { account_uuid: 'a' });
            else authority.rejectClaudeCredential(current, 'reject-current', 'access_rejected');
          }
          return config;
        });
        const before = sends;
        await load();
        service.stopBackgroundPolling();
        axios.interceptors.request.eject(interceptor);
        expect(mutated).toBe(true);
        expect(sends).toBe(before);
      }
    `)
  }, 15000)
}
