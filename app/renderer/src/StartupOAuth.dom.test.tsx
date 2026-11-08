import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, useState } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { StartupOAuth, type StartupOAuthView } from './StartupSurfaces.js'
import type { OAuthSubmitStatus } from './appModel.js'
import { ACCOUNT_CONTROL_VERSION, parseAccountControlEvent } from '../../shared/accountControlWorker.js'
import type { OAuthLoginProgress } from '../../shared/protocol.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const executor = {
  switch: async () => ({ ok: true, message: 'Switched' }),
  switchAnthropic: async () => ({ ok: true, message: 'Switched' }),
  rename: () => ({ ok: true, message: 'Renamed' }),
  delete: async () => ({ ok: true, message: 'Deleted' }),
  logout: () => ({ ok: true, message: 'Signed out' }),
  touchAll: async () => ({ ok: true, message: 'Done', touchAllResults: [] }),
  refreshUsage: async () => false,
}

test.each(['pending', 'throw'] as const)('reauth %s exposes local-save retry and succeeds without another browser login', async failure => {
  // This integration loads the Bun engine at runtime, outside the isolated renderer type graph.
  const { createSidecarAccountsDomain } = await import(new URL('../../sidecar/accountsDomain.ts', import.meta.url).href)
  const receipt = {
    provider: 'anthropic' as const, accountId: 'existing-account',
    operationId: 'retained-operation', outcome: 'committed' as const, loginGeneration: 7,
  }
  const persist = mock(async (_alias: string | undefined, _options?: { makeDefault?: boolean }) => {
    if (persist.mock.calls.length === 1) {
      if (failure === 'throw') throw new Error('Local save failed')
      return { ...receipt, outcome: 'persistence_pending' as const, loginGeneration: null }
    }
    return receipt
  })
  const begin = mock(async () => ({
    isExistingAccount: true,
    validateAlias: () => ({ ok: false as const, message: 'Do not rename' }),
    persist,
  }))
  const domain = createSidecarAccountsDomain({
    executor, reloadPool: async () => {}, reloadAnthropicPool: async () => {},
    anthropicOAuthRunner: { begin }, isFirstRunEligible: () => false,
  })
  const restartOAuth = mock(() => {})
  function Owner() {
    const [view, setView] = useState<StartupOAuthView>({ phase: 'waiting', url: null })
    const [aliasStatus, setAliasStatus] = useState<OAuthSubmitStatus>({ state: 'idle' })
    domain.setOAuthProgressSink((progress: OAuthLoginProgress) => {
      // Exercise the strict host boundary before rendering the actual progress.
      const event = parseAccountControlEvent({
        type: 'progress', version: ACCOUNT_CONTROL_VERSION, provider: 'anthropic', progress,
      })
      if (event?.type !== 'progress') throw new Error('Progress rejected')
      if (event.progress?.state === 'error') setView({ phase: 'error', ...event.progress })
      if (event.progress?.state === 'success') setView({ phase: 'success' })
    })
    return <StartupOAuth
      view={view} provider="anthropic" aliasStatus={aliasStatus}
      onBegin={restartOAuth} onRetry={restartOAuth} onCancel={() => {}} onPasteCode={() => {}}
      onSubmitAlias={alias => {
        setAliasStatus({ state: 'pending', requestId: 'local-save' })
        void domain.runVerb({ type: 'account.oauthAlias', requestId: 'local-save', alias }).then(({ result }: { result: { ok: boolean; message: string } }) => {
          setAliasStatus(result.ok ? { state: 'accepted' } : { state: 'rejected', message: result.message })
        })
      }}
    />
  }
  const tree = await harness.mount(<Owner />)
  await act(async () => {
    await domain.runVerb({ type: 'account.login', provider: 'anthropic', requestId: 'original-login' })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  const retry = [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Retry saving')
  expect(retry).toBeDefined()
  expect(tree.container.querySelector('input')).toBeNull()
  expect(tree.container.textContent).not.toContain('Name this account')
  expect(tree.container.textContent).not.toContain('Try again')
  await act(async () => { retry!.click() })
  expect(tree.container.textContent).toContain('Signed in')
  expect(begin).toHaveBeenCalledTimes(1)
  expect(persist.mock.calls).toEqual([[undefined, { makeDefault: false }], [undefined, { makeDefault: false }]])
  expect(restartOAuth).not.toHaveBeenCalled()
})

test('local saving cannot be canceled or submitted twice, and a failed save restores the retry controls', async () => {
  const cancel = mock(() => {})
  const submit = mock(() => {})
  const render = (aliasStatus: OAuthSubmitStatus) => <StartupOAuth
    view={{ phase: 'error', message: 'Save failed', retrySave: true }} provider="anthropic"
    aliasStatus={aliasStatus} onBegin={() => {}} onRetry={() => {}} onCancel={cancel}
    onPasteCode={() => {}} onSubmitAlias={submit}
  />
  const tree = await harness.mount(render({ state: 'pending', requestId: 'save' }))
  const buttons = () => [...tree.container.querySelectorAll('button')]
  expect(buttons().every(button => button.disabled)).toBe(true)
  await act(async () => {
    buttons().forEach(button => button.click())
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(cancel).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  await tree.render(render({ state: 'rejected', message: 'Still cannot save' }))
  expect(buttons().every(button => !button.disabled)).toBe(true)
  expect(tree.container.textContent).toContain('Still cannot save')
  await act(async () => { buttons().find(button => button.textContent === 'Retry saving')!.click() })
  expect(submit).toHaveBeenCalledWith('')
})
