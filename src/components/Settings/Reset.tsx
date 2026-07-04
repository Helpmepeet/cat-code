import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { Select } from '../CustomSelect/select.js'
import { LoadingState } from '../design-system/LoadingState.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'
import {
  applyRedeemedUsageReset,
  getPoolStatus,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import { refreshPoolAccountForRedeem } from '../../codex-core/accounts.js'
import {
  consumeUsageLimitReset,
  fetchPoolUsage,
  invalidateUsageCache,
} from '../../services/api/codexUsage.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  buildCandidates,
  confirmDescription,
  confirmSubtitle,
  COPY,
  isCandidateEnabled,
  mapConsumeOutcome,
  mintRedeemRequestId,
  noEligibleReason,
  redeemedTranscript,
  selectDefaultCandidate,
  successMessage,
  type RedeemCandidate,
} from './redeemResetMachine.js'

type ResetProps = {
  onOwnsEscChange: (owns: boolean) => void
  onRedeemed: (transcriptLine: string) => void
  onRequestClose: () => void
}

type Phase =
  | { name: 'checking' }
  | { name: 'check_failed' }
  | { name: 'no_eligible'; reason: string }
  | { name: 'picker' }
  | {
      name: 'confirm'
      target: RedeemCandidate
      redeemRequestId: string
      pickerShown: boolean
    }
  | { name: 'consuming'; target: RedeemCandidate; redeemRequestId: string }
  | {
      name: 'result'
      message: string
      retry?: { target: RedeemCandidate; redeemRequestId: string }
    }

async function runPreflight(
  accounts: readonly PoolAccount[],
): Promise<Map<string, { kind: 'reauth' | 'transient'; message: string }>> {
  const degraded = new Map<string, { kind: 'reauth' | 'transient'; message: string }>()
  await Promise.all(
    accounts.map(async account => {
      const outcome = await refreshPoolAccountForRedeem(account)
      if (outcome.kind === 'reauth' || outcome.kind === 'transient') {
        degraded.set(account.accountId, {
          kind: outcome.kind,
          message: outcome.message,
        })
      }
    }),
  )
  return degraded
}

export function Reset({
  onOwnsEscChange,
  onRedeemed,
  onRequestClose,
}: ResetProps): React.ReactNode {
  const [phase, setPhase] = React.useState<Phase>({ name: 'checking' })
  const [candidates, setCandidates] = React.useState<RedeemCandidate[]>([])
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const consuming = phase.name === 'consuming'
  React.useEffect(() => {
    onOwnsEscChange(consuming)
    return () => onOwnsEscChange(false)
  }, [consuming, onOwnsEscChange])

  const noop = React.useCallback(() => undefined, [])
  useKeybinding('confirm:no', noop, {
    context: 'Settings',
    isActive: consuming,
  })

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { accounts } = getPoolStatus()
        const preflightById = await runPreflight(accounts)
        const post = getPoolStatus()
        const snapshot = await fetchPoolUsage({ forceRefresh: true })
        if (cancelled) return

        const usageByAccountId = new Map(
          snapshot.accounts.map(usage => [
            usage.accountId,
            {
              email: usage.email,
              planType: usage.planType,
              resetCreditsAvailable: usage.resetCreditsAvailable,
              limitWindowSeconds: usage.primaryWindow.limitWindowSeconds,
            },
          ]),
        )
        const built = buildCandidates({
          accounts: post.accounts,
          activeIndex: post.activeIndex,
          usageByAccountId,
          preflightById,
        })
        setCandidates(built)

        const enabled = built.filter(isCandidateEnabled)
        if (enabled.length === 0) {
          setPhase({ name: 'no_eligible', reason: noEligibleReason(built) })
          return
        }
        if (enabled.length === 1) {
          setPhase({
            name: 'confirm',
            target: enabled[0],
            redeemRequestId: mintRedeemRequestId(),
            pickerShown: false,
          })
          return
        }
        setPhase({ name: 'picker' })
      } catch (error) {
        if (cancelled) return
        logForDebugging(
          `[codex-usage] Reset tab availability check failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        setPhase({ name: 'check_failed' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const consume = React.useCallback(
    async (target: RedeemCandidate, redeemRequestId: string) => {
      setPhase({ name: 'consuming', target, redeemRequestId })

      const preflightAccount = getPoolStatus().accounts.find(
        account => account.accountId === target.accountId,
      )
      if (!preflightAccount) {
        setPhase({
          name: 'result',
          message: COPY.consumeError,
          retry: { target, redeemRequestId },
        })
        return
      }

      const preflight = await refreshPoolAccountForRedeem(preflightAccount)
      if (!mountedRef.current) return
      if (preflight.kind === 'reauth') {
        setPhase({ name: 'result', message: preflight.message })
        return
      }

      const account = getPoolStatus().accounts.find(
        poolAccount => poolAccount.accountId === target.accountId,
      )
      if (!account) {
        setPhase({
          name: 'result',
          message: COPY.consumeError,
          retry: { target, redeemRequestId },
        })
        return
      }

      const outcome = await consumeUsageLimitReset(
        { accountId: account.accountId, accessToken: account.accessToken },
        redeemRequestId,
      )
      if (!mountedRef.current) return
      const result = mapConsumeOutcome(outcome)

      if (result.kind === 'success') {
        applyRedeemedUsageReset(account.accountId)
        invalidateUsageCache()
        let leftCount: number | undefined
        try {
          const refreshed = await fetchPoolUsage({ forceRefresh: true })
          leftCount = refreshed.accounts.find(
            usage => usage.accountId === account.accountId,
          )?.resetCreditsAvailable
        } catch (error) {
          logForDebugging(
            `[codex-usage] Reset post-success refresh failed for ${account.accountId.slice(0, 12)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        if (!mountedRef.current) return
        onRedeemed(redeemedTranscript(target.label, leftCount))
        setPhase({
          name: 'result',
          message: successMessage({ kind: 'success', leftCount }),
        })
        return
      }

      if (result.kind === 'no_credit') {
        invalidateUsageCache()
        setCandidates(prev =>
          prev.map(candidate =>
            candidate.accountId === target.accountId
              ? { ...candidate, resetCreditsAvailable: 0 }
              : candidate,
          ),
        )
        setPhase({ name: 'result', message: COPY.noCredit })
        return
      }

      if (result.kind === 'nothing_to_reset') {
        setPhase({ name: 'result', message: COPY.nothingToReset })
        return
      }

      setPhase({
        name: 'result',
        message: COPY.consumeError,
        retry: { target, redeemRequestId },
      })
    },
    [onRedeemed],
  )

  if (phase.name === 'checking') {
    return <LoadingState message={COPY.checking} />
  }

  if (phase.name === 'check_failed') {
    return <MessageView message={COPY.checkFailed} onClose={onRequestClose} />
  }

  if (phase.name === 'no_eligible') {
    return <MessageView message={phase.reason} onClose={onRequestClose} />
  }

  if (phase.name === 'picker') {
    return (
      <PickerView
        candidates={candidates}
        onSelect={target =>
          setPhase({
            name: 'confirm',
            target,
            redeemRequestId: mintRedeemRequestId(),
            pickerShown: true,
          })
        }
      />
    )
  }

  if (phase.name === 'confirm') {
    return (
      <ConfirmView
        target={phase.target}
        redeemRequestId={phase.redeemRequestId}
        onUse={consume}
        onCancel={() => {
          if (phase.pickerShown) {
            setPhase({ name: 'picker' })
          } else {
            onRequestClose()
          }
        }}
      />
    )
  }

  if (phase.name === 'consuming') {
    return <LoadingState message={COPY.consuming} />
  }

  if (phase.retry) {
    return (
      <RetryView
        message={phase.message}
        retry={phase.retry}
        onRetry={consume}
        onClose={onRequestClose}
      />
    )
  }

  return <MessageView message={phase.message} onClose={onRequestClose} />
}

function PickerView({
  candidates,
  onSelect,
}: {
  candidates: RedeemCandidate[]
  onSelect: (target: RedeemCandidate) => void
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const defaultTarget = selectDefaultCandidate(candidates)
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{COPY.confirmTitle}</Text>
      <Text dimColor>Choose which account to reset.</Text>
      <Select
        options={candidates.map(candidate => ({
          value: candidate.accountId,
          label: candidate.label,
          description: describeCandidate(candidate),
          disabled: !isCandidateEnabled(candidate),
        }))}
        defaultFocusValue={defaultTarget?.accountId}
        onChange={accountId => {
          const target = candidates.find(candidate => candidate.accountId === accountId)
          if (!target || !isCandidateEnabled(target)) return
          onSelect(target)
        }}
        onUpFromFirstItem={focusHeader}
        isDisabled={headerFocused}
      />
    </Box>
  )
}

function ConfirmView({
  target,
  redeemRequestId,
  onUse,
  onCancel,
}: {
  target: RedeemCandidate
  redeemRequestId: string
  onUse: (target: RedeemCandidate, redeemRequestId: string) => void
  onCancel: () => void
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const count = target.resetCreditsAvailable
  const subtitle = typeof count === 'number' ? confirmSubtitle(count) : undefined
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{COPY.confirmTitle}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Text>{confirmDescription(target)} Account: {target.label}</Text>
      <Select
        defaultFocusValue="cancel"
        options={[
          { value: 'use' as const, label: COPY.confirmItemUse },
          { value: 'cancel' as const, label: COPY.confirmItemCancel },
        ]}
        onChange={value => {
          if (value === 'use') {
            void onUse(target, redeemRequestId)
          } else {
            onCancel()
          }
        }}
        onUpFromFirstItem={focusHeader}
        isDisabled={headerFocused}
      />
    </Box>
  )
}

function RetryView({
  message,
  retry,
  onRetry,
  onClose,
}: {
  message: string
  retry: { target: RedeemCandidate; redeemRequestId: string }
  onRetry: (target: RedeemCandidate, redeemRequestId: string) => void
  onClose: () => void
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{COPY.confirmTitle}</Text>
      <Text>{message}</Text>
      <Select
        defaultFocusValue="retry"
        options={[
          { value: 'retry' as const, label: COPY.tryAgain },
          { value: 'close' as const, label: COPY.close },
        ]}
        onChange={value => {
          if (value === 'retry') {
            void onRetry(retry.target, retry.redeemRequestId)
          } else {
            onClose()
          }
        }}
        onUpFromFirstItem={focusHeader}
        isDisabled={headerFocused}
      />
    </Box>
  )
}

function MessageView({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{COPY.confirmTitle}</Text>
      <Text>{message}</Text>
      <Select
        options={[{ value: 'close' as const, label: COPY.close }]}
        onChange={onClose}
        onUpFromFirstItem={focusHeader}
        isDisabled={headerFocused}
      />
    </Box>
  )
}

function describeCandidate(candidate: RedeemCandidate): string {
  if (candidate.disabledReason) {
    return candidate.disabledReason
  }
  const parts: string[] = []
  if (candidate.status === 'capped' && candidate.statusReason === 'usage_cap') {
    parts.push('usage capped')
  } else if (candidate.isActive) {
    parts.push('active')
  }
  parts.push(
    typeof candidate.resetCreditsAvailable === 'number'
      ? `${candidate.resetCreditsAvailable} reset${candidate.resetCreditsAvailable === 1 ? '' : 's'}`
      : 'reset availability unknown',
  )
  return parts.join(' · ')
}
