import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import { createSidecarPermissionDomain } from './permissionDomain.js'

function makeStore(context?: Partial<ToolPermissionContext>) {
  const base = getDefaultAppState()
  return createStore({
    ...base,
    toolPermissionContext: { ...base.toolPermissionContext, ...context },
  })
}

test('setMode applies the requested external mode to the live context', () => {
  const store = makeStore()
  const domain = createSidecarPermissionDomain(store)

  domain.setMode('acceptEdits')

  expect(store.getState().toolPermissionContext.mode).toBe('acceptEdits')
  expect(domain.getToolPermissionContext().mode).toBe('acceptEdits')
})

test('setMode runs the REAL engine transition, not a bare mode assignment', () => {
  // transitionPermissionMode clears the prePlanMode stash on plan exit
  // (permissionSetup.ts — the cleanup a bare `applyPermissionUpdate({type:
  // 'setMode'})` would skip). If the stash survives, the idiom regressed.
  const store = makeStore({ mode: 'plan', prePlanMode: 'acceptEdits' })
  const domain = createSidecarPermissionDomain(store)

  domain.setMode('default')

  const context = store.getState().toolPermissionContext
  expect(context.mode).toBe('default')
  expect(context.prePlanMode).toBeUndefined()
})

test('an unfeatured sidecar does not advertise classifier-backed auto', () => {
  const domain = createSidecarPermissionDomain(makeStore())

  expect(domain.getDisplayFacts().permissionClassifierEnabled).toBe(false)
})

test.each([
  ['gpt-6.1-sol', 'openai', true],
  ['claude-opus-5-5', 'firstParty', true],
  ['claude-sonnet-5-5', 'firstParty', true],
  ['opus', 'firstParty', true],
  ['sonnet', 'firstParty', true],
  ['claude-opus-5', 'firstParty', true],
  ['claude-sonnet-5', 'firstParty', true],
  ['claude-opus-4-6', 'firstParty', true],
  ['claude-sonnet-4-6', 'firstParty', true],
  ['claude-haiku-4-5', 'firstParty', false],
  ['claude-sonnet-4-5', 'firstParty', false],
  ['claude-opus-5-5', 'bedrock', false],
] as const)('%s on %s enforces Auto availability and the real transition', async (model, provider, available) => {
  const configDir = mkdtempSync(join(tmpdir(), 'catcode-auto-mode-'))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--feature=TRANSCRIPT_CLASSIFIER',
        '-e',
        `
          import { getDefaultAppState } from './src/state/AppStateStore.ts'
          import { createStore } from './src/state/store.ts'
          import { createSidecarPermissionDomain } from './app/sidecar/permissionDomain.ts'
          import { setSessionProvider } from './src/bootstrap/state.ts'

          setSessionProvider(${JSON.stringify(provider)})

          const base = getDefaultAppState()
          const store = createStore({
            ...base,
            toolPermissionContext: { ...base.toolPermissionContext },
          })
          const domain = createSidecarPermissionDomain(store)
          if (domain.getDisplayFacts().permissionClassifierEnabled !== ${available}) {
            throw new Error('incorrect auto availability for ${model}/${provider}')
          }
          if (!${available}) {
            let rejected = false
            try { domain.setMode('auto') } catch { rejected = true }
            if (!rejected || domain.getToolPermissionContext().mode === 'auto') {
              throw new Error('unavailable auto mode was accepted')
            }
            process.exit(0)
          }
          domain.setMode('auto')
          const context = store.getState().toolPermissionContext
          if (
            context.mode !== 'auto' ||
            context.strippedDangerousRules === undefined
          ) {
            throw new Error('classifier-backed auto transition did not run')
          }
          const restore = domain.getAutoRestoreState()
          if (restore.unavailableReason !== null || !restore.active) {
            throw new Error('active auto mode is unavailable for restoration')
          }
        `,
      ],
      {
        cwd: join(import.meta.dir, '..', '..'),
        env: {
          ...process.env,
          CAT_CODE_MODEL: model,
          ANTHROPIC_MODEL: model,
          USER_TYPE: 'external',
          CLAUDE_CONFIG_DIR: configDir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(`feature-enabled sidecar probe failed:\n${stderr}`)
    }
    expect(exitCode).toBe(0)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('setMode to the current mode preserves the context reference (no churn)', () => {
  const store = makeStore({ mode: 'dontAsk' })
  const domain = createSidecarPermissionDomain(store)
  const before = store.getState().toolPermissionContext

  domain.setMode('dontAsk')

  expect(store.getState().toolPermissionContext).toBe(before)
})

test('subscribeToolPermissionContext fires only on context changes', () => {
  const store = makeStore()
  const domain = createSidecarPermissionDomain(store)
  const seen: string[] = []
  const unsubscribe = domain.subscribeToolPermissionContext(context => {
    seen.push(context.mode)
  })

  // Unrelated app-state change: context reference untouched → no callback.
  store.setState(prev => ({ ...prev, thinkingEnabled: !prev.thinkingEnabled }))
  expect(seen).toEqual([])

  domain.setMode('plan')
  expect(seen).toEqual(['plan'])

  unsubscribe()
  domain.setMode('default')
  expect(seen).toEqual(['plan'])
})
