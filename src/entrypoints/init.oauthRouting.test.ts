import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'fs'
import * as auth from '../utils/auth.js'
import * as providers from '../utils/model/providers.js'
import * as oauth from '../services/oauth/client.js'
import * as policy from '../services/policyLimits/index.js'
import * as remoteSettings from '../services/remoteManagedSettings/index.js'
import * as eligibility from '../services/remoteManagedSettings/syncCache.js'
import { startProviderStartupServices } from './providerStartup.js'

beforeEach(() => {
  spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
  spyOn(providers, 'getAPIProvider').mockReturnValue('firstParty')
  spyOn(providers, 'isFirstPartyAnthropicBaseUrl').mockReturnValue(true)
  spyOn(oauth, 'populateOAuthAccountInfoIfNeeded').mockResolvedValue(false)
  spyOn(policy, 'loadPolicyLimits').mockResolvedValue(undefined)
  spyOn(remoteSettings, 'loadRemoteManagedSettings').mockResolvedValue(undefined)
  spyOn(eligibility, 'refreshRemoteManagedSettingsEligibility').mockReturnValue(true)
})
afterEach(() => mock.restore())

test.each(['openai', 'bedrock', 'vertex', 'foundry'] as const)('%s startup does not prepare a saved Claude profile', provider => {
  spyOn(providers, 'getAPIProvider').mockReturnValue(provider)
  startProviderStartupServices(true)
  expect(oauth.populateOAuthAccountInfoIfNeeded).not.toHaveBeenCalled()
  expect(auth.isClaudeAISubscriber).not.toHaveBeenCalled()
  // Ineligible loaders must still settle their early promises, using their
  // existing provider gates rather than leaving policy waits hanging.
  expect(policy.loadPolicyLimits).toHaveBeenCalledTimes(1)
  expect(remoteSettings.loadRemoteManagedSettings).toHaveBeenCalledTimes(1)
})

test('API-key startup does not refresh a saved Claude profile', () => {
  spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(false)
  startProviderStartupServices(false)
  expect(oauth.populateOAuthAccountInfoIfNeeded).not.toHaveBeenCalled()
})

test('a custom endpoint does not refresh a saved Claude profile', () => {
  spyOn(providers, 'isFirstPartyAnthropicBaseUrl').mockReturnValue(false)
  startProviderStartupServices(true)
  expect(oauth.populateOAuthAccountInfoIfNeeded).not.toHaveBeenCalled()
})

test('settled Claude OAuth startup populates its profile', () => {
  startProviderStartupServices(false)
  expect(oauth.populateOAuthAccountInfoIfNeeded).toHaveBeenCalledTimes(1)
})

// Importing main starts the CLI. Only its placement needs a source-wiring
// assertion; the routed startup entry point is exercised above.
test('CLI starts authenticated background work after final agent/model routing', () => {
  const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
  const providerSelection = main.indexOf('setSessionProvider(\n      resolveStartupProvider(')
  const startup = main.indexOf('startProviderStartupServices(', providerSelection)
  expect(providerSelection).toBeGreaterThan(-1)
  expect(startup).toBeGreaterThan(providerSelection)
  const init = readFileSync(new URL('./init.ts', import.meta.url), 'utf8')
  expect(init).not.toContain('populateOAuthAccountInfoIfNeeded')
  expect(init).toContain('initializeRemoteManagedSettingsLoadingPromise()')
  expect(init).toContain('initializePolicyLimitsLoadingPromise()')
})
