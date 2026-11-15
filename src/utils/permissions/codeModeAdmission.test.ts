import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate settings, authentication, feature flags, and network from the live engine.
test('script admission retains real child policy without repeated Auto review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-admission-'))
  const source = join(import.meta.dir, '../..')
  const script = `
    import { expect } from 'bun:test'
    import { z } from ${JSON.stringify(join(source, '../node_modules/zod/v4/index.js'))}
    globalThis.MACRO = { VERSION: 'test', BUILD_TIME: 'test', PACKAGE_URL: 'cat-code',
      FEEDBACK_CHANNEL: 'github', ISSUES_EXPLAINER: 'test', VERSION_CHANGELOG: 'test' }
    const admission = await import(${JSON.stringify(join(source, 'tools/REPLTool/codeModeAdmission.ts'))})
    const { hasPermissionsToUseTool } = await import(${JSON.stringify(join(source, 'utils/permissions/permissions.ts'))})
    const { YOLO_CLASSIFIER_TOOL_NAME } = await import(${JSON.stringify(join(source, 'utils/permissions/yoloClassifier.ts'))})
    let requests = 0
    globalThis.fetch = async (url, options) => {
      expect(String(url)).toStartWith('https://api.anthropic.com/')
      requests++
      const body = JSON.parse(options.body)
      return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant',
        model: body.model, content: [{ type: 'tool_use', id: 'toolu_test',
          name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: false } }],
        stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }), {
          headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
    }
    let state = { toolPermissionContext: { mode: 'auto', additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false } }
    const context = { abortController: new AbortController(), getAppState: () => state,
      setAppState: update => { state = update(state) }, messages: [], options: { tools: [] } }
    const tool = { name: 'SyntheticChild', inputSchema: z.object({}),
      checkPermissions: async () => ({ behavior: 'ask', message: 'approval' }) }
    const message = { uuid: 'assistant-1', type: 'assistant', message: { id: 'msg_1', role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'REPL', input: { code: 'await child()' } }] } }
    const evaluate = (tested = tool, ctx = context) => hasPermissionsToUseTool(tested, {}, ctx, message, 'tool-1')
    const owner = admission.createCodeModeAdmissionOwner(context, {})
    const cell = admission.beginCodeModeCell(owner, { cellId: 'one', code: 'await child()' })
    const outer = { ...tool, name: 'REPL', toAutoClassifierInput: () => cell.code }
    context.options.tools = [outer, tool]
    const outerDecision = await evaluate(outer)
    expect({ outerDecision, requests }).toMatchObject({ outerDecision: { behavior: 'allow' }, requests: 1 })
    expect(requests).toBe(1)
    admission.admitCodeModeCell(cell)
    await admission.withCodeModeAdmission(cell, async () => {
      for (let i = 0; i < 10; i++) expect((await evaluate()).behavior).toBe('allow')
      expect((await evaluate({ ...tool, checkPermissions: async () => ({ behavior: 'deny', message: 'no' }) })).behavior).toBe('deny')
      for (const classifierApprovable of [false, true]) {
        expect((await evaluate({ ...tool, checkPermissions: async () => ({ behavior: 'ask', message: 'safety',
          decisionReason: { type: 'safetyCheck', reason: 'protected', classifierApprovable } }) })).behavior).toBe('ask')
      }
      expect((await evaluate({ ...tool, requiresUserInteraction: () => true })).behavior).toBe('ask')
      expect((await evaluate({ ...tool, name: 'PowerShell' })).behavior).toBe('ask')
      expect((await evaluate(tool, { ...context, agentId: 'other-worker' })).behavior).toBe('ask')
      state.toolPermissionContext.alwaysAskRules = { session: ['SyntheticChild'] }
      expect((await evaluate()).behavior).toBe('ask')
      state.toolPermissionContext.alwaysDenyRules = { session: ['SyntheticChild'] }
      expect((await evaluate()).behavior).toBe('deny')
      state.toolPermissionContext.alwaysAskRules = {}
      state.toolPermissionContext.alwaysDenyRules = {}
    })
    const second = admission.beginCodeModeCell(owner, { cellId: 'two', code: 'child()' })
    admission.admitCodeModeCell(second)
    expect(admission.getCodeModeAdmission(context)).toBeUndefined()
    const retainedHelper = () => evaluate()
    let release
    const wait = new Promise(resolve => { release = resolve })
    const oldCallback = admission.withCodeModeAdmission(cell, async () => {
      await wait
      return evaluate()
    })
    await admission.withCodeModeAdmission(second, async () => {
      expect((await retainedHelper()).behavior).toBe('allow')
      release()
      expect((await oldCallback).behavior).toBe('ask')
    })
    await admission.withCodeModeAdmission(cell, async () => expect((await evaluate()).behavior).toBe('ask'))
    await admission.withCodeModeAdmission(second, async () => {
      expect((await evaluate()).behavior).toBe('allow')
      state = { ...state, toolPermissionContext: { ...state.toolPermissionContext } }
      expect((await evaluate()).behavior).toBe('ask')
    })
    const third = admission.beginCodeModeCell(owner, { cellId: 'three', code: 'child()' })
    admission.admitCodeModeCell(third)
    admission.revokeCodeModeAdmission(owner)
    await admission.withCodeModeAdmission(third, async () => expect((await evaluate()).behavior).toBe('ask'))
    state.toolPermissionContext.shouldAvoidPermissionPrompts = true
    await admission.withCodeModeAdmission(third, async () => expect((await evaluate()).behavior).toBe('deny'))
    expect(requests).toBe(1)
    state.toolPermissionContext.shouldAvoidPermissionPrompts = false
    const fourth = admission.beginCodeModeCell(owner, { cellId: 'four', code: 'child()' })
    admission.admitCodeModeCell(fourth)
    state.toolPermissionContext.mode = 'default'
    await admission.withCodeModeAdmission(fourth, async () => {
      expect((await evaluate()).behavior).toBe('ask')
      expect(admission.getCodeModeAdmission(context)).toBe(false)
    })
    state.toolPermissionContext.mode = 'auto'
    await admission.withCodeModeAdmission(fourth, async () => expect((await evaluate()).behavior).toBe('ask'))
    const fifth = admission.beginCodeModeCell(owner, { cellId: 'five', code: 'child()' })
    admission.admitCodeModeCell(fifth)
    context.abortController.abort()
    expect(admission.withCodeModeAdmission(fifth, () => admission.getCodeModeAdmission(context))).toBe(false)
    expect(requests).toBe(1)
    expect(() => admission.withCodeModeAdmission({ cellId: 'forged', code: '' }, () => {})).toThrow()
  `
  try {
    const child = Bun.spawn([process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT', '--eval', script], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root,
        NODE_ENV: 'test', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-test-token',
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_AUTO_MODE_MODEL: 'sonnet',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
