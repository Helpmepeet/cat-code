import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('pinned evaluator sends the chosen account and policy through the real adapter without refresh, retry or fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'pinned-eval-'))
  try {
    const probe = join(root, 'probe.ts')
    // A child process gives the real credential lifecycle its own configuration
    // root before any module initializes. Only the network boundary is replaced.
    writeFileSync(probe, `
      const { pinnedCodexTransport } = await import(${JSON.stringify(join(import.meta.dir, 'transport.ts'))});
      const { codexCredentialLifecycle } = await import(${JSON.stringify(join(import.meta.dir, '../../src/services/api/codexCredentialLifecycle.ts'))});
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/config.ts'))});
      enableConfigs();
      const account = { accountId: 'fixture-pinned-account', alias: 'fixture-main', accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, source: 'vault', status: 'healthy',
        credentialGeneration: 1, credentialGenerationState: 'bound', lastUsedAt: 0, vaultFilePath: ${JSON.stringify(join(root, 'account.json'))} };
      await codexCredentialLifecycle.withTransaction(account.accountId, { operationKind: 'login', operationId: 'fixture-login' }, permit => {
        const prepared = codexCredentialLifecycle.prepareLogin(permit);
        if (prepared.status !== 'applied') throw new Error('fixture lifecycle preparation failed');
        codexCredentialLifecycle.commitLogin(permit, { expectedGeneration: prepared.record.credentialGeneration });
      });
      const sends = [];
      globalThis.fetch = async (url, init) => {
        sends.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
        return new Response('quota exhausted fixture-access', { status: 429 });
      };
      const pinned = pinnedCodexTransport(account, 'gpt-6-luna', 1);
      const options = { model: 'gpt-6-luna', provider: 'openai', max_tokens: 64,
        system: [{ type: 'text', text: 'Synthetic classifier policy' }], messages: [{ role: 'user', content: 'Synthetic action' }],
        tools: [{ name: 'fixture_verdict', description: 'fixture', input_schema: { type: 'object', properties: { shouldBlock: { type: 'boolean' } } } }],
        tool_choice: { type: 'tool', name: 'fixture_verdict' }, temperature: 0, reasoningEffort: 'medium',
        skipSystemPromptPrefix: true, querySource: 'auto_mode' };
      let rejectedQuota = false;
      try { await pinned.send(options); } catch { rejectedQuota = true; }
      let rejectedBudget = false;
      try { await pinned.send(options); } catch { rejectedBudget = true; }
      let rejectedOtherModel = false;
      try { await pinned.send({ ...options, model: 'gpt-6.1-sol' }); } catch { rejectedOtherModel = true; }
      let rejectedExpired = false;
      try { pinnedCodexTransport({ ...account, expiresAt: Date.now() }, 'gpt-6-luna', 1); } catch { rejectedExpired = true; }
      let rejectedUnbound = false;
      try { pinnedCodexTransport({ ...account, credentialGeneration: 0 }, 'gpt-6-luna', 1); } catch { rejectedUnbound = true; }
      let rejectedOtherEndpoint = false;
      try { await globalThis.fetch('https://auth.example.test/token'); } catch { rejectedOtherEndpoint = true; }
      console.log(JSON.stringify({ rejectedQuota, rejectedBudget, rejectedOtherModel, rejectedExpired, rejectedUnbound,
        rejectedOtherEndpoint, secretsRedacted: !JSON.stringify(pinned.failures).includes('fixture-access'),
        backendSends: pinned.backendSends, attempts: pinned.requestsAttempted, firstFailureStatus: pinned.failures[0]?.status, sends: sends.map(s => ({
        url: s.url, account: s.headers['chatgpt-account-id'], policy: s.body.instructions,
        toolChoice: s.body.tool_choice, tools: s.body.tools.map(t => t.name), reasoningEffort: s.body.reasoning.effort,
      })) }));
    `)
    const result = Bun.spawnSync([process.execPath, probe], { env: { ...process.env, CLAUDE_CONFIG_DIR: root } })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      rejectedQuota: true, rejectedBudget: true, rejectedOtherModel: true, rejectedExpired: true, rejectedUnbound: true,
      rejectedOtherEndpoint: true, secretsRedacted: true,
      backendSends: 1, attempts: 1, firstFailureStatus: 429,
      sends: [{ url: 'https://chatgpt.com/backend-api/codex/responses', account: 'fixture-pinned-account',
        policy: 'Synthetic classifier policy', toolChoice: { type: 'function', name: 'fixture_verdict' },
        tools: ['fixture_verdict'], reasoningEffort: 'medium' }],
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
