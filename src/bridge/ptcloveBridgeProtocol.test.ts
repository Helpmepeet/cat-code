import { describe, expect, test } from 'bun:test'
import {
  isPtcloveInbound,
  riskForPtcloveApproval,
} from './ptcloveBridgeProtocol.js'

describe('ptclove bridge protocol', () => {
  test('requires session_id on inbound control messages after hello', () => {
    expect(
      isPtcloveInbound({
        type: 'approval_decision',
        session_id: 's1',
        id: 'a1',
        decision: 'approve',
      }),
    ).toBe(true)

    expect(
      isPtcloveInbound({
        type: 'approval_decision',
        id: 'a1',
        decision: 'approve',
      }),
    ).toBe(false)
  })

  test('classifies destructive shell actions as high risk', () => {
    for (const command of [
      'rm -rf /tmp/project/build',
      'rm -fr /tmp/project/build',
      'rm -Rf /tmp/project/build',
      'git clean -xdf',
      'git clean -dfx',
      'git clean -fxd',
    ]) {
      expect(
        riskForPtcloveApproval('Bash', { command }, {
          cwd: '/tmp/project',
        }),
      ).toBe('high')
    }
    expect(
      riskForPtcloveApproval('Bash', { command: 'git push --force origin main' }, {
        cwd: '/tmp/project',
      }),
    ).toBe('high')
  })

  test('classifies recoverable writes as medium and reads as low', () => {
    expect(
      riskForPtcloveApproval('Edit', { file_path: '/tmp/project/a.ts' }, {
        cwd: '/tmp/project',
      }),
    ).toBe('medium')
    expect(
      riskForPtcloveApproval('Bash', { command: 'git status --short' }, {
        cwd: '/tmp/project',
      }),
    ).toBe('low')
  })
})
