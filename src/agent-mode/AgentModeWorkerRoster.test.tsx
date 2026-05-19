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

    expect(extractText(node)).toContain('Agent Mode workers')
    expect(extractText(node)).toContain('loading…')
  })

  test('shows none yet after loading with no worker summary', () => {
    const node = AgentModeWorkerRoster({ loaded: true, summary: null })

    expect(extractText(node)).toContain('none yet')
  })

  test('falls back to the raw role label for unknown worker roles', () => {
    const summary: AgentModeWorkerUxSummary = {
      hasWorkers: true,
      active: 1,
      ready: 0,
      reviewed: 0,
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
    expect(text).toContain('└─')
  })

  test('renders compact worker status without competing with the main spinner', () => {
    const summary: AgentModeWorkerUxSummary = {
      hasWorkers: true,
      active: 1,
      ready: 0,
      reviewed: 0,
      resumable: 0,
      stale: 0,
      attention: 0,
      pendingSynthesis: 0,
      visibleWorkers: [
        worker({
          agentId: 'worker-1',
          handle: 'Ada',
          role: 'Explore',
          description: 'Map data and analysis surfaces',
          status: 'running',
        }),
      ],
    }

    const node = AgentModeWorkerRoster({
      loaded: true,
      summary,
      compact: true,
    })
    const text = extractText(node)

    expect(text).toContain('Workers')
    expect(text).not.toContain('◉ Agent Mode workers')
    expect(text).toContain('1 active')
    expect(text).toContain('@Ada')
    expect(React.isValidElement(node) ? node.props.marginBottom : undefined).toBe(
      0,
    )
  })

  test('renders exclusive summary buckets and tree markers for visible workers', () => {
    const summary: AgentModeWorkerUxSummary = {
      hasWorkers: true,
      active: 1,
      ready: 1,
      reviewed: 2,
      attention: 1,
      pendingSynthesis: 1,
      visibleWorkers: [
        worker({
          agentId: 'worker-1',
          handle: 'turing',
          description: 'Map the live worker state',
          status: 'running',
        }),
        worker({
          agentId: 'worker-2',
          handle: 'curie',
          description: 'Summarize finished worker output',
          status: 'completed',
          synthesisStatus: 'pending',
        }),
        worker({
          agentId: 'worker-3',
          handle: 'hopper',
          description: 'Investigate the blocked worker path',
          status: 'failed',
        }),
      ],
    }

    const node = AgentModeWorkerRoster({ loaded: true, summary })
    const text = extractText(node)

    expect(text).toContain('1 active')
    expect(text).toContain('1 result ready')
    expect(text).toContain('2 reviewed')
    expect(text).toContain('1 attention')
    expect(text).not.toContain('done')
    expect(text).not.toContain('pending review')
    expect(text).toContain('├─ @turing')
    expect(text).toContain('├─ @curie')
    expect(text).toContain('└─ @hopper')
    expect(text).toContain('result ready')
  })
})
