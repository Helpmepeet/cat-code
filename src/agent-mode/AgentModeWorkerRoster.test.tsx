import { describe, expect, test } from 'bun:test'
import * as React from 'react'

import { AgentModeWorkerRoster } from './AgentModeWorkerRoster.js'
import type { AgentModeWorkerUxSummary } from './workerUxSummary.js'
import type { AgentModeWorkerSession } from './sessionState.js'

function extractText(node: React.ReactNode): string {
  if (
    node == null ||
    typeof node === 'boolean' ||
    typeof node === 'number' ||
    typeof node === 'string'
  ) {
    return String(node ?? '')
  }

  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }

  if (React.isValidElement(node)) {
    return extractText(node.props.children)
  }

  return ''
}

function worker(
  overrides: Partial<AgentModeWorkerSession> &
    Pick<AgentModeWorkerSession, 'agentId'>,
): AgentModeWorkerSession {
  return {
    agentId: overrides.agentId,
    handle: overrides.handle,
    role: overrides.role ?? 'agent-mode-coding-worker',
    description: overrides.description ?? 'Worker sample',
    status: overrides.status ?? 'running',
    synthesisStatus: overrides.synthesisStatus,
    resumable: overrides.resumable,
    worktreePath: overrides.worktreePath ?? null,
    outputSummary: overrides.outputSummary,
    error: overrides.error,
    spawnedAt: overrides.spawnedAt,
  }
}

describe('AgentModeWorkerRoster', () => {
  test('shows loading state before the first durable read completes', () => {
    const node = AgentModeWorkerRoster({ loaded: false, summary: null })

    expect(extractText(node)).toContain('workers: loading…')
  })

  test('shows none yet after loading with no worker summary', () => {
    const node = AgentModeWorkerRoster({ loaded: true, summary: null })

    expect(extractText(node)).toContain('workers: none yet')
  })

  test('falls back to the raw role label for unknown worker roles', () => {
    const summary: AgentModeWorkerUxSummary = {
      hasWorkers: true,
      active: 1,
      done: 0,
      attention: 0,
      pendingSynthesis: 0,
      visibleWorkers: [
        worker({
          agentId: 'worker-1',
          handle: 'synth-a',
          role: 'agent-mode-synthesizer',
          description: 'Summarize worker output',
        }),
      ],
    }

    const node = AgentModeWorkerRoster({ loaded: true, summary })
    const text = extractText(node)

    expect(text).toContain('@synth-a')
    expect(text).toContain('agent-mode-synthesizer')
    expect(text).toContain('running')
  })
})
