import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import { formatDuration } from '../utils/format.js'
import { truncateToWidth } from '../utils/truncate.js'

type Props = {
  status: {
    primary: string
    secondary?: string
    waitingForUserInput: boolean
  }
  startedAt: number
  estimatedCost: number
  tokensIn: number
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`
}

export function AgentModeStatusHeader({
  status,
  startedAt,
  estimatedCost,
  tokensIn,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const isWaiting =
    status.waitingForUserInput || status.primary.toLowerCase().includes('waiting')
  const indicatorColor = isWaiting ? 'warning' : 'success'
  const elapsed = formatDuration(Math.max(0, now - startedAt), {
    hideTrailingZeros: true,
  })
  const meta = `${elapsed} · ${formatCost(estimatedCost)}`
  const bullet = '●'
  const gap = 2
  const availablePrimary = Math.max(
    0,
    columns - stringWidth(`${bullet} `) - stringWidth(meta) - gap,
  )
  const primary = truncateToWidth(status.primary, availablePrimary)
  const primaryWidth = stringWidth(`${bullet} ${primary}`)
  const spacerWidth = Math.max(0, columns - primaryWidth - stringWidth(meta))
  const secondary = status.secondary
    ? truncateToWidth(status.secondary, Math.max(0, columns))
    : null

  void tokensIn

  return (
    <Box flexDirection="column" width="100%">
      <Box width="100%">
        <Text color={indicatorColor}>{bullet}</Text>
        <Text> {primary}</Text>
        {spacerWidth > 0 ? <Text>{' '.repeat(spacerWidth)}</Text> : null}
        <Text dimColor>{meta}</Text>
      </Box>
      {secondary ? (
        <Box width="100%">
          <Text dimColor wrap="truncate-end">
            {secondary}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
