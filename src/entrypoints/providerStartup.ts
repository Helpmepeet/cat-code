import { isClaudeAISubscriber } from '../utils/auth.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from '../utils/model/providers.js'
import { loadPolicyLimits } from '../services/policyLimits/index.js'
import { loadRemoteManagedSettings } from '../services/remoteManagedSettings/index.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import { refreshRemoteManagedSettingsEligibility } from '../services/remoteManagedSettings/syncCache.js'

/** Called only after agent/model selection and restored account routing settle. */
export function startProviderStartupServices(uploadSettings: boolean): void {
  refreshRemoteManagedSettingsEligibility()
  // Both loaders resolve the early loading promises even for ineligible routes.
  // Keep their existing cache fallback, polling, and security application paths.
  void loadRemoteManagedSettings()
  void loadPolicyLimits()
  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) return
  if (!isClaudeAISubscriber()) return
  void populateOAuthAccountInfoIfNeeded()
  if (uploadSettings) {
    void import('../services/settingsSync/index.js').then(service => service.uploadUserSettingsInBackground())
  }
}
