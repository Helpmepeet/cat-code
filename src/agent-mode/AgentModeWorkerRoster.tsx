import React from 'react'
import { Box, Text } from '../ink.js'
import { truncateToWidth } from '../utils/format.js'
import {
  getWorkerDisplayHandle,
  getWorkerStatusLabel,
  type AgentModeWorkerUxSummary,
} from './workerUxSummary.js'

function getRoleLabel(role: string): string {
  if (role === 'agent-mode-coding-worker') {
    return 'worker'
  }
  if (role === 'agent-mode-verifier') {
    return 'verifier'
  }
  return role
}

function getStatusColor(statusLabel: string): 'warning' | undefined {
  return statusLabel === 'pending review' || statusLabel === 'attention'
    ? 'warning'
    : undefined
}

export function AgentModeWorkerRoster({
  loaded,
  summary,
}: {
  loaded: boolean
  summary: AgentModeWorkerUxSummary | null
}): React.ReactNode {
  return (
    <Box width="100%" flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="claude">◉ Agent Mode</Text>
        <Text dimColor> · orchestrating workers</Text>
      </Box>
      {!loaded ? (
        <Box>
          <Text dimColor>  workers: loading…</Text>
        </Box>
      ) : !summary?.hasWorkers ? (
        <Box>
          <Text dimColor>  workers: none yet</Text>
        </Box>
      ) : (
        <>
          <Box>
            <Text dimColor>  workers: </Text>
            <Text>{summary.active} active</Text>
            {summary.done > 0 ? (
              <Text dimColor>{` · ${summary.done} done`}</Text>
            ) : null}
            {summary.pendingSynthesis > 0 ? (
              <Text color="warning">
                {` · ${summary.pendingSynthesis} pending review`}
              </Text>
            ) : null}
            {summary.attention > 0 ? (
              <Text color="warning">{` · ${summary.attention} attention`}</Text>
            ) : null}
          </Box>
          {summary.visibleWorkers.map(worker => {
            const statusLabel = getWorkerStatusLabel(worker)

            return (
              <Box key={worker.agentId}>
                <Text>{`  ${getWorkerDisplayHandle(worker)}`}</Text>
                <Text dimColor>{` · ${getRoleLabel(worker.role)}`}</Text>
                <Text color={getStatusColor(statusLabel)}>
                  {` · ${statusLabel}`}
                </Text>
                <Text dimColor>
                  {` · ${truncateToWidth(worker.description, 64)}`}
                </Text>
              </Box>
            )
          })}
        </>
      )}
    </Box>
  )
}
