import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Separate process: no inherited credentials, provider state, or module mocks.
test('Claude-only Auto defaults and missing-account fallback cross the real retry boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-provider-'))
  const sourceRoot = join(import.meta.dir, '../..')
  const script = `
    import { expect } from 'bun:test'
    globalThis.MACRO = { VERSION: 'test', BUILD_TIME: 'test', PACKAGE_URL: 'cat-code',
      FEEDBACK_CHANNEL: 'github', ISSUES_EXPLAINER: 'test', VERSION_CHANGELOG: 'test' }
    const { _forTest, classifyYoloAction, isProviderAuthenticationErrorForTest,
      YOLO_CLASSIFIER_TOOL_NAME } = await import(${JSON.stringify(join(sourceRoot, 'utils/permissions/yoloClassifier.ts'))})
    const { sideQuery } = await import(${JSON.stringify(join(sourceRoot, 'utils/sideQuery.ts'))})
    const { CannotRetryError } = await import(${JSON.stringify(join(sourceRoot, 'services/api/withRetry.ts'))})
    const { getGlobalConfig } = await import(${JSON.stringify(join(sourceRoot, 'utils/config.ts'))})
    const { resetSettingsCache } = await import(${JSON.stringify(join(sourceRoot, 'utils/settings/settingsCache.ts'))})
    const { writeFile } = await import('node:fs/promises')
    const { z } = await import(${JSON.stringify(join(sourceRoot, '../node_modules/zod/v4/index.js'))})
    const requests = []
    let deny = false
    globalThis.fetch = async (url, options) => {
      // No native fetch is retained or called, including for unexpected routes.
      expect(String(url)).toStartWith('https://api.anthropic.com/')
      const body = JSON.parse(options.body)
      requests.push(body.model)
      if (deny) return new Response(JSON.stringify({ type: 'error', error: {
        type: 'permission_error', message: 'policy forbidden' } }), { status: 403,
        headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant',
        model: body.model, content: [{ type: 'tool_use', id: 'toolu_test',
          name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: false } }],
        stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }), {
          headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
    }
    expect(_forTest.getClassifierModel()).toBe('sonnet')
    const cfg = getGlobalConfig()
    cfg.codexOAuth = { accessToken: 'synthetic', refreshToken: 'synthetic',
      expiresAt: Date.now() + 3600000, accountId: 'synthetic' }
    expect(_forTest.getClassifierModel()).toBe('gpt-6-luna')
    delete cfg.codexOAuth
    await writeFile(process.env.CLAUDE_CONFIG_DIR + '/settings.json', JSON.stringify({
      autoMode: { model: 'claude-custom-explicit' } }))
    resetSettingsCache()
    expect(_forTest.getClassifierModel()).toBe('claude-custom-explicit')
    process.env.CLAUDE_CODE_AUTO_MODE_MODEL = 'gpt-6-luna'
    expect(_forTest.getClassifierModel()).toBe('gpt-6-luna')
    let wrapped
    try { await sideQuery({ model: 'gpt-6-luna', provider: 'openai', maxRetries: 0,
      max_tokens: 64, skipSystemPromptPrefix: true, querySource: 'auto_mode',
      messages: [{ role: 'user', content: 'synthetic' }] }) } catch (error) { wrapped = error }
    expect(wrapped).toBeInstanceOf(CannotRetryError)
    expect(wrapped.originalError.name).toBe('CodexAccountUnavailableError')
    expect(isProviderAuthenticationErrorForTest(wrapped, 'openai')).toBe(true)
    expect(requests).toHaveLength(0)
    const tool = { name: 'SyntheticTool', inputSchema: z.object({ command: z.string() }),
      toAutoClassifierInput: input => input.command }
    const action = { role: 'assistant', content: [{ type: 'tool_use', name: tool.name,
      id: 'toolu_pending', input: { command: 'inspect fixture' } }] }
    const context = { mode: 'auto', additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false }
    const classify = () => classifyYoloAction([], action, [tool], context, new AbortController().signal)
    expect(await classify()).toMatchObject({ shouldBlock: false, stage: 'fast' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('sonnet')
    delete process.env.CLAUDE_CODE_AUTO_MODE_MODEL
    await writeFile(process.env.CLAUDE_CONFIG_DIR + '/settings.json', '{}')
    resetSettingsCache()
    expect(_forTest.getClassifierModel()).toBe('sonnet')
    expect(await classify()).toMatchObject({ shouldBlock: false, stage: 'fast' })
    expect(requests).toHaveLength(2)
    deny = true
    expect(await classify()).toMatchObject({ shouldBlock: true, unavailable: true })
    expect(requests).toHaveLength(3)
  `
  try {
    const child = Bun.spawn([
      process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
      '--eval', script,
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        NODE_ENV: 'test',
        CLAUDE_CONFIG_DIR: root,
        CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-test-token',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a stage profile mismatch keeps full inputs for both reviewer stages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'classifier-profile-'))
  const permissionsRoot = import.meta.dir
  const script = `
    import { expect, mock } from 'bun:test'
    globalThis.fetch = () => { throw new Error('Unexpected network call') }
    const manifest = { schema: 2, model: 'gpt-6-luna', requests: [{}], stageProfiles: {} }
    mock.module(${JSON.stringify(join(permissionsRoot, 'autoModeReductionQualification.json'))}, () => ({ default: manifest }))
    const { _forTest, buildAutoModeCritiqueSystemPrompt, YOLO_CLASSIFIER_TOOL_NAME } =
      await import(${JSON.stringify(join(permissionsRoot, 'yoloClassifier.ts'))})
    const { autoModePolicyDigest, autoModeReviewStageProfile } =
      await import(${JSON.stringify(join(permissionsRoot, 'autoModeReductionQualification.ts'))})
    const { z } = await import(${JSON.stringify(join(permissionsRoot, '../../../node_modules/zod/v4/index.js'))})
    const tool = { name: 'Write', inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      toAutoClassifierInput: ({ file_path, content }) => file_path + ' ' + content }
    const messages = [
      { type: 'user', uuid: 'user-test', message: { content: 'Write Build complete. to reports/status.txt.' } },
      { type: 'assistant', uuid: 'assistant-test', message: { content: [{ type: 'tool_use',
        name: tool.name, id: 'toolu_archive', input: { file_path: 'notes/archive.txt', content: 'Quince log. Amber sunlight.' } }] } },
      { type: 'user', uuid: 'result-test', sourceToolAssistantUUID: 'assistant-test', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_archive', content: 'Saved' }] } },
    ]
    const action = { role: 'assistant', content: [{ type: 'tool_use', name: tool.name,
      id: 'toolu_pending', input: { file_path: 'reports/status.txt', content: 'Build complete.' } }] }
    const context = { mode: 'auto', additionalWorkingDirectories: new Map(), alwaysAllowRules: {},
      alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false }
    const capture = async inputVariant => {
      const requests = []
      await _forTest.classifyYoloAction(messages, action, [tool], context, new AbortController().signal,
        { inputVariant, sideQuery: async options => {
          requests.push(options)
          return { id: 'synthetic', model: options.model, content: [{ type: 'tool_use',
            name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: requests.length === 1 } }],
            usage: { input_tokens: 1, output_tokens: 1 } }
        } })
      expect(requests).toHaveLength(2)
      return requests
    }
    const [reducedFast, reducedThinking] = await capture('reduced')
    const [fullFast, fullThinking] = await capture('full')
    expect(fullFast.system).not.toEqual(reducedFast.system)
    expect(fullThinking.messages).not.toEqual(reducedThinking.messages)
    manifest.policyDigest = autoModePolicyDigest(buildAutoModeCritiqueSystemPrompt())
    manifest.stageProfiles.fast = autoModeReviewStageProfile(reducedFast)
    manifest.stageProfiles.thinking = autoModeReviewStageProfile(reducedThinking)
    const [matchingFast, matchingThinking] = await capture()
    expect(matchingFast.system).toEqual(reducedFast.system)
    expect(matchingThinking.messages).toEqual(reducedThinking.messages)

    for (const stage of ['fast', 'thinking']) {
      const previous = manifest.stageProfiles[stage]
      manifest.stageProfiles[stage] = '0'.repeat(64)
      const [driftedFast, driftedThinking] = await capture()
      expect(driftedFast.system).toEqual(fullFast.system)
      expect(driftedThinking.messages).toEqual(fullThinking.messages)
      manifest.stageProfiles[stage] = previous
    }
  `
  try {
    const child = Bun.spawn([
      process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
      '--eval', script,
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', CLAUDE_CONFIG_DIR: root,
        CLAUDE_CODE_AUTO_MODE_MODEL: 'gpt-6-luna', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        ANTHROPIC_API_KEY: 'synthetic-test-key',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
