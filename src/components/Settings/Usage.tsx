import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useEffect, useState } from 'react';
import { extraUsage as extraUsageCommand } from '../../commands/extra-usage/index.js';
import { formatCost } from '../../cost-tracker.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { type ExtraUsage, fetchUtilization, type RateLimit, type Utilization } from '../../services/api/usage.js';
import { getSubscriptionType, isClaudeAISubscriber } from '../../utils/auth.js';
import { formatResetText } from '../../utils/format.js';
import { logError } from '../../utils/log.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline } from '../design-system/Byline.js';
import { ProgressBar } from '../design-system/ProgressBar.js';
import { isEligibleForOverageCreditGrant, OverageCreditUpsell } from '../LogoV2/OverageCreditUpsell.js';
import { describeCodexAccountAvailability, hasAnyPoolAccount, getPoolStatus } from '../../services/api/codexAccountPool.js';
import { getCodexLeaseSnapshot } from '../../services/api/codexAccountLeaseManager.js';
import { buildPoolUsageDisplayAccounts, fetchPoolUsage, isFreePlan, sortPoolUsageDisplayAccounts, type PoolUsageSnapshot } from '../../services/api/codexUsage.js';
type LimitBarProps = {
  title: string;
  limit: RateLimit;
  maxWidth: number;
  showTimeInReset?: boolean;
  extraSubtext?: string;
};
function LimitBar(t0) {
  const $ = _c(34);
  const {
    title,
    limit,
    maxWidth,
    showTimeInReset: t1,
    extraSubtext
  } = t0;
  const showTimeInReset = t1 === undefined ? true : t1;
  const {
    utilization,
    resets_at
  } = limit;
  if (utilization === null) {
    return null;
  }
  const usedText = `${Math.floor(utilization)}% used`;
  let subtext;
  if (resets_at) {
    let t2;
    if ($[0] !== resets_at || $[1] !== showTimeInReset) {
      t2 = formatResetText(resets_at, true, showTimeInReset);
      $[0] = resets_at;
      $[1] = showTimeInReset;
      $[2] = t2;
    } else {
      t2 = $[2];
    }
    subtext = `Resets ${t2}`;
  }
  if (extraSubtext) {
    if (subtext) {
      subtext = `${extraSubtext} · ${subtext}`;
    } else {
      subtext = extraSubtext;
    }
  }
  if (maxWidth >= 62) {
    let t2;
    if ($[3] !== title) {
      t2 = <Text bold={true}>{title}</Text>;
      $[3] = title;
      $[4] = t2;
    } else {
      t2 = $[4];
    }
    const t3 = utilization / 100;
    let t4;
    if ($[5] !== t3) {
      t4 = <ProgressBar ratio={t3} width={50} fillColor="rate_limit_fill" emptyColor="rate_limit_empty" />;
      $[5] = t3;
      $[6] = t4;
    } else {
      t4 = $[6];
    }
    let t5;
    if ($[7] !== usedText) {
      t5 = <Text>{usedText}</Text>;
      $[7] = usedText;
      $[8] = t5;
    } else {
      t5 = $[8];
    }
    let t6;
    if ($[9] !== t4 || $[10] !== t5) {
      t6 = <Box flexDirection="row" gap={1}>{t4}{t5}</Box>;
      $[9] = t4;
      $[10] = t5;
      $[11] = t6;
    } else {
      t6 = $[11];
    }
    let t7;
    if ($[12] !== subtext) {
      t7 = subtext && <Text dimColor={true}>{subtext}</Text>;
      $[12] = subtext;
      $[13] = t7;
    } else {
      t7 = $[13];
    }
    let t8;
    if ($[14] !== t2 || $[15] !== t6 || $[16] !== t7) {
      t8 = <Box flexDirection="column">{t2}{t6}{t7}</Box>;
      $[14] = t2;
      $[15] = t6;
      $[16] = t7;
      $[17] = t8;
    } else {
      t8 = $[17];
    }
    return t8;
  } else {
    let t2;
    if ($[18] !== title) {
      t2 = <Text bold={true}>{title}</Text>;
      $[18] = title;
      $[19] = t2;
    } else {
      t2 = $[19];
    }
    let t3;
    if ($[20] !== subtext) {
      t3 = subtext && <><Text> </Text><Text dimColor={true}>· {subtext}</Text></>;
      $[20] = subtext;
      $[21] = t3;
    } else {
      t3 = $[21];
    }
    let t4;
    if ($[22] !== t2 || $[23] !== t3) {
      t4 = <Text>{t2}{t3}</Text>;
      $[22] = t2;
      $[23] = t3;
      $[24] = t4;
    } else {
      t4 = $[24];
    }
    const t5 = utilization / 100;
    let t6;
    if ($[25] !== maxWidth || $[26] !== t5) {
      t6 = <ProgressBar ratio={t5} width={maxWidth} fillColor="rate_limit_fill" emptyColor="rate_limit_empty" />;
      $[25] = maxWidth;
      $[26] = t5;
      $[27] = t6;
    } else {
      t6 = $[27];
    }
    let t7;
    if ($[28] !== usedText) {
      t7 = <Text>{usedText}</Text>;
      $[28] = usedText;
      $[29] = t7;
    } else {
      t7 = $[29];
    }
    let t8;
    if ($[30] !== t4 || $[31] !== t6 || $[32] !== t7) {
      t8 = <Box flexDirection="column">{t4}{t6}{t7}</Box>;
      $[30] = t4;
      $[31] = t6;
      $[32] = t7;
      $[33] = t8;
    } else {
      t8 = $[33];
    }
    return t8;
  }
}
export function Usage(): React.ReactNode {
  const {
    columns
  } = useTerminalSize();
  const availableWidth = columns - 2; // 2 for screen padding
  const maxWidth = Math.min(availableWidth, 80);
  const showAnthropic = isClaudeAISubscriber();
  const showCodex = hasAnyPoolAccount();
  return <Box flexDirection="column" gap={1} width="100%">
      {showAnthropic ? <AnthropicUsageSection maxWidth={maxWidth} /> : null}
      {showCodex ? <CodexPoolUsageSection maxWidth={maxWidth} /> : null}
      {!showAnthropic && !showCodex
        ? <Text dimColor>/usage requires an Anthropic subscription or OpenAI Codex account.</Text>
        : null}

      <Text dimColor>
        <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
      </Text>
    </Box>;
}

function AnthropicUsageSection({ maxWidth }: { maxWidth: number }): React.ReactNode {
  const [utilization, setUtilization] = useState<Utilization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchUtilization();
      if (data === null) {
        setError('Usage data is temporarily unavailable. Retry in a moment.');
      } else {
        setUtilization(data);
      }
    } catch (err) {
      logError(err as Error);
      const axiosError = err as { response?: { data?: unknown } };
      const responseBody = axiosError.response?.data
        ? jsonStringify(axiosError.response.data)
        : undefined;
      setError(
        responseBody
          ? `Failed to load usage data: ${responseBody}`
          : 'Failed to load usage data',
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUtilization();
  }, [loadUtilization]);

  useKeybinding('settings:retry', () => {
    void loadUtilization();
  }, {
    context: 'Settings',
    isActive: !!error && !isLoading
  });

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Anthropic subscription</Text>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint action="settings:retry" context="Settings" fallback="r" description="retry" />
          </Byline>
        </Text>
      </Box>
    );
  }

  if (isLoading || !utilization) {
    return (
      <Box flexDirection="column">
        <Text bold>Anthropic subscription</Text>
        <Text dimColor>Loading…</Text>
      </Box>
    );
  }

  const subscriptionType = getSubscriptionType();
  const showSonnetBar =
    subscriptionType === 'max' ||
    subscriptionType === 'team' ||
    subscriptionType === null;
  const limits = [
    { title: 'Current session', limit: utilization.five_hour },
    { title: 'Current week (all models)', limit: utilization.seven_day },
    ...(showSonnetBar
      ? [{ title: 'Current week (Sonnet only)', limit: utilization.seven_day_sonnet }]
      : []),
  ];

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Anthropic subscription</Text>
      {limits.some(({ limit }) => limit) ? null : (
        <Text dimColor>Usage limits are not available for this subscription.</Text>
      )}
      {limits.map(({ title, limit }) =>
        limit ? (
          <LimitBar key={title} title={title} limit={limit} maxWidth={maxWidth} />
        ) : null,
      )}
      {utilization.extra_usage ? (
        <ExtraUsageSection
          extraUsage={utilization.extra_usage}
          maxWidth={maxWidth}
        />
      ) : null}
      {isEligibleForOverageCreditGrant() ? (
        <OverageCreditUpsell maxWidth={maxWidth} />
      ) : null}
    </Box>
  );
}

function ExtraUsageSection({
  extraUsage,
  maxWidth,
}: {
  extraUsage: ExtraUsage;
  maxWidth: number;
}): React.ReactNode {
  const subscriptionType = getSubscriptionType();
  if (subscriptionType !== 'pro' && subscriptionType !== 'max') return null;

  if (!extraUsage.is_enabled) {
    return extraUsageCommand.isEnabled() ? (
      <Box flexDirection="column">
        <Text bold>Extra usage</Text>
        <Text dimColor>Extra usage not enabled · /extra-usage to enable</Text>
      </Box>
    ) : null;
  }
  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold>Extra usage</Text>
        <Text dimColor>Unlimited</Text>
      </Box>
    );
  }
  if (
    typeof extraUsage.used_credits !== 'number' ||
    typeof extraUsage.utilization !== 'number'
  ) {
    return null;
  }

  const now = new Date();
  const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2);
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2);
  return (
    <LimitBar
      title="Extra usage"
      limit={{
        utilization: extraUsage.utilization,
        resets_at: oneMonthReset.toISOString(),
      }}
      showTimeInReset={false}
      extraSubtext={`${formattedUsedCredits} / ${formattedMonthlyLimit} spent`}
      maxWidth={maxWidth}
    />
  );
}

function CodexPoolUsageSection({ maxWidth }: { maxWidth: number }): React.ReactNode {
  const [snapshot, setSnapshot] = useState<PoolUsageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        // Deliberate (F10): opening the Usage tab refreshes routing hints so the
        // next request routes on the freshest usage data. Display drives routing
        // here on purpose; keep in sync with the AccountsPanel fetch.
        const data = await fetchPoolUsage({ forceRefresh: true, updateRoutingHints: true });
        setSnapshot(data);
      } catch {
        // best-effort; silently skip on failure
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const pool = getPoolStatus();
  const mainLeaseAccountId = getCodexLeaseSnapshot().mainLease?.accountId;
  const displayAccounts = sortPoolUsageDisplayAccounts(buildPoolUsageDisplayAccounts(pool.accounts, snapshot, mainLeaseAccountId ?? pool.activeIndex));

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <Text bold>Codex accounts</Text>
        <Text dimColor>Loading…</Text>
      </Box>
    );
  }

  if (displayAccounts.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Codex accounts</Text>
      {displayAccounts.map((acct) => {
        const label = acct.alias ?? acct.accountId.slice(0, 12);
        const isFree = !!acct.usage && isFreePlan(acct.usage.planType);
        const isCapped = !isFree && (acct.usage
          ? acct.usage.limitReached || !acct.usage.allowed
          : acct.status === 'capped');
        const availabilityText = describeCodexAccountAvailability(acct);
        const statusTag = isFree
          ? ' · free — no Codex access'
          : acct.error && acct.switchable !== false
            ? ` · ${availabilityText} · usage unavailable`
            : ` · ${availabilityText}`;

        const primaryResetAt = acct.usage && acct.usage.primaryWindow.resetAt > 0
          ? new Date(acct.usage.primaryWindow.resetAt * 1000).toISOString()
          : null;
        const weeklyResetAt = acct.usage && acct.usage.secondaryWindow.resetAt > 0
          ? new Date(acct.usage.secondaryWindow.resetAt * 1000).toISOString()
          : null;
        const unavailableText = acct.error && acct.switchable !== false
          ? acct.error !== 'Fetch returned null'
            ? `${availabilityText}. Usage unavailable right now (${acct.error}).`
            : `${availabilityText}. Usage unavailable right now.`
          : availabilityText;

        return (
          <Box key={acct.accountId} flexDirection="column">
            <Text bold={true} color={isCapped ? 'red' : undefined}>{label}{statusTag}</Text>
            {acct.usage ? (
              isFree ? (
                // Free plans have no Codex quota; the backend returns a synthetic
                // "100% used, resets in ~28d" window. Don't render usage bars that
                // imply an exhausted-but-resettable quota.
                <Text dimColor={true}>Upgrade to a paid plan to use Codex.</Text>
              ) : <>
                {acct.switchable === false && acct.usage.allowed && !acct.usage.limitReached
                  ? <Text dimColor>Quota info only; account is not routable.</Text>
                  : null}
                <LimitBar
                  title="5h"
                  limit={{ utilization: acct.usage.primaryWindow.usedPercent, resets_at: primaryResetAt }}
                  maxWidth={maxWidth}
                />
                {acct.usage.hasSecondaryWindow !== false ? (
                  <LimitBar
                    title="7d"
                    limit={{ utilization: acct.usage.secondaryWindow.usedPercent, resets_at: weeklyResetAt }}
                    maxWidth={maxWidth}
                    showTimeInReset={false}
                  />
                ) : null}
	                {acct.usage.resetCreditsAvailable !== undefined ? (
	                  <Text dimColor>
	                    {acct.usage.resetCreditsAvailable} usage limit reset{acct.usage.resetCreditsAvailable === 1 ? '' : 's'} available
	                    {acct.usage.resetCreditsAvailable > 0 ? ' · Reset tab to redeem' : ''}
	                  </Text>
	                ) : null}
              </>
            ) : <Text dimColor={true}>{unavailableText}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
