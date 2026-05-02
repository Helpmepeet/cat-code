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
  return statusLabel === 'attention' ? 'warning' : undefined
}

function getTreePrefix(index: number, total: number): string {
  return index === total - 1 ? '  └─ ' : '  ├─ '
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
        <Text color="claude">◉ Agent Mode workers</Text>
      </Box>
      {!loaded ? (
        <Box>
          <Text dimColor>  loading…</Text>
        </Box>
      ) : !summary?.hasWorkers ? (
        <Box>
          <Text dimColor>  none yet</Text>
        </Box>
      ) : (
        <>
          <Box>
            <Text>{summary.active} active</Text>
            {summary.ready > 0 ? (
              <Text>{` · ${summary.ready} result ready`}</Text>
            ) : null}
            {summary.reviewed > 0 ? (
              <Text dimColor>{` · ${summary.reviewed} reviewed`}</Text>
            ) : null}
            {summary.attention > 0 ? (
              <Text color="warning">{` · ${summary.attention} attention`}</Text>
            ) : null}
          </Box>
          {summary.visibleWorkers.map((worker, index) => {
            const statusLabel = getWorkerStatusLabel(worker)

            return (
              <Box key={worker.agentId}>
                <Text>{`${getTreePrefix(index, summary.visibleWorkers.length)}${getWorkerDisplayHandle(worker)}`}</Text>
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
