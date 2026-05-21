import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getSubscriptionName, isClaudeAISubscriber } from '../../utils/auth.js'
import { fetchUtilization, type Utilization } from '../../services/api/usage.js'
import { useAppState } from '../../state/AppState.js'
import {
  buildPoolUsageDisplayAccounts,
  fetchPoolUsage,
  type PoolUsageSnapshot,
} from '../../services/api/codexUsage.js'
import { getPoolStatus } from '../../services/api/codexAccountPool.js'
import { getClaudePoolStatus, isClaudePoolActive } from '../../services/api/claudeAccountPool.js'

// ── Props ──────────────────────────────────────────────────────────────────

interface AccountsPanelProps {
  availableWidth: number
  accentColor?: string
  textColor?: string
}

interface AccountsPanelContentProps {
  availableWidth: number
  accentColor: string
  textColor?: string
  hasAnthropicAccount: boolean
  hasCodexAccounts: boolean
}

// ── Helpers ────────────────────────────────────────────────────────────────

const BAR_WIDTH = 16

// Renders a bar showing % USED (filled = used, empty = remaining)
function renderBar(usedPct: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, usedPct)) / 100) * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

function formatReset(seconds: number): string {
  if (seconds <= 0) return 'now'
  const totalMinutes = Math.floor(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h >= 24) {
    const d = Math.floor(h / 24)
    const rh = h % 24
    return rh > 0 ? `${d}d${rh}h` : `${d}d`
  }
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  return `${m}m`
}

function formatResetFromIso(isoStr: string): string {
  const resetMs = new Date(isoStr).getTime()
  const secondsLeft = Math.max(0, Math.floor((resetMs - Date.now()) / 1000))
  return formatReset(secondsLeft)
}

// Single usage row: label + bar + % used + reset time
function UsageRow({
  label,
  usedPct,
  resetStr,
  textColor,
}: {
  label: string
  usedPct: number
  resetStr: string
  textColor?: string
}) {
  const used = Math.max(0, Math.min(100, Math.round(usedPct)))
  const pctStr = `${used}%`.padEnd(4)
  return (
    <Text>
      <Text color={textColor} dimColor>{label} </Text>
      <Text color={textColor}>{renderBar(usedPct)}</Text>
      <Text color={textColor}> {pctStr}</Text>
      <Text color={textColor} dimColor> resets {resetStr}</Text>
    </Text>
  )
}

// ── Anthropic section ──────────────────────────────────────────────────────

interface AnthropicSectionProps {
  utilization: Utilization | null | 'loading'
  accentColor: string
  textColor?: string
}

function AnthropicSection({ utilization, accentColor, textColor }: AnthropicSectionProps) {
  const multiAccount = isClaudePoolActive()

  if (multiAccount) {
    const { accounts, activeIndex } = getClaudePoolStatus()
    if (accounts.length === 0) return null

    const isLoading = utilization === 'loading'
    const fiveHour = !isLoading && utilization ? utilization.five_hour ?? null : null
    const sevenDay = !isLoading && utilization ? utilization.seven_day ?? null : null

    return (
      <Box flexDirection="column" gap={1}>
        <Text color={textColor} bold>Anthropic</Text>
        {accounts.map((acct, i) => {
          const isActive = i === activeIndex
          const label = acct.alias ?? acct.emailAddress

          return (
            <Box key={acct.accountUuid} flexDirection="column">
              <Text>
                <Text color={isActive ? accentColor : textColor} dimColor={!isActive}>
                  {isActive ? '● ' : '○ '}
                </Text>
                <Text color={textColor} dimColor={!isActive}>{label}</Text>
              </Text>
              <Box paddingLeft={2} flexDirection="column">
                {isActive ? (
                  isLoading ? (
                    <Text color={textColor} dimColor>loading…</Text>
                  ) : fiveHour?.utilization != null ? (
                    <>
                      <UsageRow
                        label="5h"
                        usedPct={fiveHour.utilization}
                        resetStr={fiveHour.resets_at ? formatResetFromIso(fiveHour.resets_at) : '?'}
                        textColor={textColor}
                      />
                      {sevenDay?.utilization != null && (
                        <UsageRow
                          label="7d"
                          usedPct={sevenDay.utilization}
                          resetStr={sevenDay.resets_at ? formatResetFromIso(sevenDay.resets_at) : '?'}
                          textColor={textColor}
                        />
                      )}
                    </>
                  ) : (
                    <Text color={textColor} dimColor>—</Text>
                  )
                ) : (
                  <Text color={textColor} dimColor>—</Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  // Single-account fallback
  const config = getGlobalConfig()
  const active = config.oauthAccount

  if (!active) return null

  const billingType = isClaudeAISubscriber() ? getSubscriptionName() : null
  const isLoading = utilization === 'loading'
  const fiveHour = !isLoading && utilization ? utilization.five_hour ?? null : null
  const sevenDay = !isLoading && utilization ? utilization.seven_day ?? null : null

  return (
    <Box flexDirection="column">
      <Text color={textColor} bold>Anthropic</Text>
      <Text>
        <Text color={accentColor}>● </Text>
        <Text color={textColor}>{active.emailAddress}</Text>
        {billingType ? <Text color={textColor} dimColor>  {billingType}</Text> : null}
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {isLoading ? (
          <Text color={textColor} dimColor>loading…</Text>
        ) : fiveHour?.utilization != null ? (
          <>
            <UsageRow
              label="5h"
              usedPct={fiveHour.utilization}
              resetStr={fiveHour.resets_at ? formatResetFromIso(fiveHour.resets_at) : '?'}
              textColor={textColor}
            />
            {sevenDay?.utilization != null && (
              <UsageRow
                label="7d"
                usedPct={sevenDay.utilization}
                resetStr={sevenDay.resets_at ? formatResetFromIso(sevenDay.resets_at) : '?'}
                textColor={textColor}
              />
            )}
          </>
        ) : (
          <Text color={textColor} dimColor>—</Text>
        )}
      </Box>
    </Box>
  )
}

// ── Codex section ──────────────────────────────────────────────────────────

interface CodexSectionProps {
  usageSnapshot: PoolUsageSnapshot | null
  accentColor: string
  textColor?: string
}

function CodexSection({ usageSnapshot, accentColor, textColor }: CodexSectionProps) {
  const { accounts, activeIndex, initialized } = getPoolStatus()

  if (!initialized || accounts.length === 0) return null

  const displayAccounts = buildPoolUsageDisplayAccounts(
    accounts,
    usageSnapshot,
    activeIndex,
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={textColor} bold>Codex</Text>
      {displayAccounts.map((acct) => {
        const label = acct.alias ?? acct.accountId.slice(0, 12)
        const unavailableLabel = acct.status === 'capped'
          ? 'capped'
          : acct.status === 'dead'
            ? 'unavailable'
            : acct.error
              ? 'usage unavailable'
              : '—'

        return (
          <Box key={acct.accountId} flexDirection="column">
            <Text>
              <Text color={acct.isActive ? accentColor : textColor} dimColor={!acct.isActive}>
                {acct.isActive ? '● ' : '○ '}
              </Text>
              <Text color={textColor} dimColor={!acct.isActive}>{label}</Text>
            </Text>
            <Box paddingLeft={2} flexDirection="column">
              {acct.usage == null ? (
                <Text color={textColor} dimColor>{unavailableLabel}</Text>
              ) : (
                <>
                  <UsageRow
                    label="5h"
                    usedPct={acct.usage.primaryWindow.usedPercent}
                    resetStr={formatReset(acct.usage.primaryWindow.resetAfterSeconds)}
                    textColor={textColor}
                  />
                  <UsageRow
                    label="7d"
                    usedPct={acct.usage.secondaryWindow.usedPercent}
                    resetStr={formatReset(acct.usage.secondaryWindow.resetAfterSeconds)}
                    textColor={textColor}
                  />
                </>
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export function AccountsPanel({ availableWidth, accentColor = 'startupAccent', textColor }: AccountsPanelProps) {
  if (availableWidth < 60) return null

  const config = getGlobalConfig()
  const { accounts: codexAccounts, initialized: codexInitialized } = getPoolStatus()
  const claudePool = getClaudePoolStatus()
  const hasAnthropicAccount = !!config.oauthAccount || (claudePool.initialized && claudePool.accounts.length > 0)
  const hasCodexAccounts = codexInitialized && codexAccounts.length > 0

  if (!hasAnthropicAccount && !hasCodexAccounts) return null

  return (
    <AccountsPanelContent
      availableWidth={availableWidth}
      accentColor={accentColor}
      textColor={textColor}
      hasAnthropicAccount={hasAnthropicAccount}
      hasCodexAccounts={hasCodexAccounts}
    />
  )
}

function AccountsPanelContent({
  availableWidth,
  accentColor,
  textColor,
  hasAnthropicAccount,
  hasCodexAccounts,
}: AccountsPanelContentProps) {
  const authVersion = useAppState(s => s.authVersion)
  const [utilization, setUtilization] = useState<Utilization | null | 'loading'>('loading')
  const [codexUsageSnapshot, setCodexUsageSnapshot] = useState<PoolUsageSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchUtilization()
      .then((result) => { if (!cancelled) setUtilization(result) })
      .catch(() => { if (!cancelled) setUtilization(null) })
    return () => { cancelled = true }
  }, [authVersion])

  useEffect(() => {
    if (!hasCodexAccounts) return
    let cancelled = false
    fetchPoolUsage()
      .then((snapshot) => { if (!cancelled) setCodexUsageSnapshot(snapshot) })
      .catch(() => { if (!cancelled) setCodexUsageSnapshot(null) })
    return () => { cancelled = true }
  }, [hasCodexAccounts, authVersion])

  // Each section has a natural content width: bar(16) + label(3) + "100% "(5)
  // + "resets 99h99m"(13) + padding + account line
  // Estimate: account row ~40 chars, usage row ~40 chars
  const naturalColWidth = 42
  const gap = 4
  const bothSections = hasAnthropicAccount && hasCodexAccounts
  const blockWidth = bothSections
    ? naturalColWidth * 2 + gap
    : naturalColWidth
  const leftPad = Math.max(0, Math.floor((availableWidth - blockWidth) / 2))

  return (
    <Box paddingLeft={leftPad}>
      <Box flexDirection="row" gap={gap}>
        {hasAnthropicAccount && (
          <Box width={naturalColWidth} flexDirection="column">
            <AnthropicSection utilization={utilization} accentColor={accentColor} textColor={textColor} />
          </Box>
        )}
        {hasCodexAccounts && (
          <Box width={naturalColWidth} flexDirection="column">
            <CodexSection usageSnapshot={codexUsageSnapshot} accentColor={accentColor} textColor={textColor} />
          </Box>
        )}
      </Box>
    </Box>
  )
}
