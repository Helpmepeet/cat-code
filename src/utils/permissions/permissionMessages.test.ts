import { describe, expect, test } from 'bun:test'
import {
  AUTO_REJECT_MESSAGE,
  DONT_ASK_REJECT_MESSAGE,
  DENIAL_WORKAROUND_GUIDANCE,
  SUBAGENT_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
  isClassifierDenial,
} from '../messages.js'

const workerEnding = "If this action is essential, report the blocker to the parent using this run's escalation instructions."
const worker = { agentId: 'worker-1' }

describe('permission denial audience', () => {
  for (const [name, build] of [
    ['general', AUTO_REJECT_MESSAGE],
    ['dontAsk', DONT_ASK_REJECT_MESSAGE],
    ['classifier', buildYoloRejectionMessage],
  ] as const) {
    test(`${name} preserves main guidance and directs workers to their parent`, () => {
      const main = build('example')
      expect(main).toContain(DENIAL_WORKAROUND_GUIDANCE)
      expect(build('example', {})).toBe(main)
      expect(main).not.toContain(workerEnding)
      const delegated = build('example', worker)
      expect(delegated.endsWith(workerEnding)).toBe(true)
      expect(delegated).toContain('do not attempt to bypass the intent behind this denial')
      expect(delegated).toContain('do not use your ability to run tests to execute non-test actions')
      expect(delegated).not.toContain('STOP and explain to the user')
      expect(delegated).not.toContain('recommend what permission rules')
    })
  }

  test('classifier reasons survive without claiming an explicit user rejection', () => {
    const reason = 'Action would expose private credentials'
    for (const context of [{}, worker]) {
      const message = buildYoloRejectionMessage(reason, context)
      expect(message).toStartWith(`Permission for this action has been denied. Reason: ${reason}.`)
      expect(isClassifierDenial(message)).toBe(true)
      expect(message).not.toContain("The user doesn't want")
      expect(message).not.toContain('The user said:')
    }
  })

  test('general denial reasons remain intact', () => {
    expect(AUTO_REJECT_MESSAGE('Bash', worker)).toStartWith('Permission to use Bash has been denied.')
    expect(DONT_ASK_REJECT_MESSAGE('Bash', worker)).toStartWith("Permission to use Bash has been denied because Cat Code is running in don't ask mode.")
    expect(SUBAGENT_REJECT_MESSAGE.endsWith(workerEnding)).toBe(true)
    expect(SUBAGENT_REJECT_MESSAGE).not.toContain("The user doesn't want")
  })

  test('temporary classifier failure stays retryable, not a policy denial', () => {
    const message = buildClassifierUnavailableMessage('Bash', 'test-classifier')
    expect(message).toContain('test-classifier is temporarily unavailable')
    expect(message).toContain('cannot determine the safety of Bash right now')
    expect(message).toContain('Wait briefly and then try this action again.')
    expect(isClassifierDenial(message)).toBe(false)
    expect(message).not.toContain('has been denied')
    expect(message).not.toContain(workerEnding)
    expect(message).not.toContain('bypass')
  })
})
