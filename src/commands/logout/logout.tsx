import * as React from 'react';
import { setPromptCache1hAllowlist, setPromptCache1hEligible } from '../../bootstrap/state.js';
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js';
import { Text } from '../../ink.js';
import {
  refreshGrowthBookAfterAuthChange,
  resetGrowthBook,
} from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { resetClaudeAiLimits } from '../../services/claudeAiLimits.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry is loaded lazily to avoid pulling in ~1.1MB of OpenTelemetry at startup
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { clearCodexOAuthTokens, getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js';
import { getClaudePoolStatus, removeClaudeAccount, syncClaudeAccountToStorage } from '../../services/api/claudeAccountPool.js';
import { clearBetasCaches } from '../../utils/betas.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js';
import { resetUserCache } from '../../utils/user.js';
import { invalidateUsageCache } from '../../services/api/codexUsage.js';
export async function performLogout({
  clearOnboarding = false
}): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const {
    flushTelemetry
  } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();
  await removeApiKey();

  // Wipe all secure storage data on logout
  const secureStorage = getSecureStorage();
  secureStorage.delete();
  clearCodexOAuthTokens();
  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = {
      ...current
    };
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false;
      updated.subscriptionNoticeCount = 0;
      updated.hasAvailableSubscription = false;
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: []
        };
      }
    }
    updated.codexOAuth = undefined;
    updated.oauthAccount = undefined;
    return updated;
  });
}

// clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(options: {
  refreshGrowthBook?: boolean
} = {}): Promise<void> {
  // Clear the OAuth token cache
  getClaudeAIOAuthTokens.cache?.clear?.();
  invalidateUsageCache();
  clearTrustedDeviceTokenCache();
  clearBetasCaches();
  clearToolSchemaCache();

  // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
  resetUserCache();
  if (options.refreshGrowthBook === false) resetGrowthBook();
  else refreshGrowthBookAfterAuthChange();

  // Clear Grove config cache
  getGroveNoticeConfig.cache?.clear?.();
  getGroveSettings.cache?.clear?.();

  // Clear remotely managed settings cache
  await clearRemoteManagedSettingsCache();

  // Clear policy limits cache
  await clearPolicyLimitsCache();

  // Reset Claude rate-limit state so the new account doesn't inherit
  // the previous account's usage warnings or rejected status.
  // Pass silent=true to prevent dropping telemetry events inside logout teardowns.
  resetClaudeAiLimits(true);

  // Reset prompt-cache eligibility latches so they re-evaluate for the new account
  setPromptCache1hEligible(null);
  setPromptCache1hAllowlist(null);

  // Clear disk-cached extra usage disabled reason so check1mAccess.ts
  // re-evaluates model access for the new account
  saveGlobalConfig(current => ({
    ...current,
    cachedExtraUsageDisabledReason: undefined,
  }));
}
export async function call(): Promise<React.ReactNode> {
  const claudePool = getClaudePoolStatus();
  const claudeHealthy = claudePool.initialized
    ? claudePool.accounts.filter(a => a.status === 'healthy').length
    : 0;

  // If multiple Claude accounts exist, remove only the active one and switch
  if (claudeHealthy > 1) {
    const active = claudePool.accounts[claudePool.activeIndex];
    if (active) {
      removeClaudeAccount(active.accountUuid);
      syncClaudeAccountToStorage();
      await clearAuthRelatedCaches();
      const remaining = getClaudePoolStatus();
      const newActive = remaining.accounts[remaining.activeIndex];
      const label = newActive?.alias ?? newActive?.emailAddress ?? '?';
      return <Text>Removed Claude account {active.alias ?? active.emailAddress}. Active account is now {label}.</Text>;
    }
  }

  // Single account or no pool — full destructive logout
  await performLogout({
    clearOnboarding: true
  });
  const message = <Text>Logged out of current session credentials.{'\n'}Codex vault profiles remain on disk. Use /delete-account {'<alias>'} --confirm to remove one.</Text>;
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);
  return message;
}
