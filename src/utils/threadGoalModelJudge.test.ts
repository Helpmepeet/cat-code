import { describe, expect, test } from 'bun:test'
import { parseThreadGoalJudgeReply } from './threadGoalModelJudge.js'

const GOOD = JSON.stringify({
  verdicts: [
    { criterionId: 'guide', verdict: 'proven', reason: 'covered' },
    {
      criterionId: 'notes',
      verdict: 'not-proven',
      reason: 'insufficient-evidence',
    },
  ],
})

describe('parsing a judge reply', () => {
  test('a well-formed reply parses', () => {
    expect(parseThreadGoalJudgeReply(GOOD)).toEqual([
      { criterionId: 'guide', verdict: 'proven', reason: 'covered' },
      {
        criterionId: 'notes',
        verdict: 'not-proven',
        reason: 'insufficient-evidence',
      },
    ])
  })

  test('a fenced reply parses, because models fence anyway', () => {
    expect(parseThreadGoalJudgeReply('```json\n' + GOOD + '\n```')).toHaveLength(2)
    expect(parseThreadGoalJudgeReply('```\n' + GOOD + '\n```')).toHaveLength(2)
  })

  test('anything unparseable is null, never a partial pass', () => {
    // Strictness here is what makes the fail-closed guarantee real: a
    // half-understood reply is treated as no reply.
    for (const bad of [
      '',
      'sure, the criteria look met to me',
      '{}',
      '{"verdicts":"yes"}',
      JSON.stringify({ verdicts: [{ criterionId: 'guide' }] }),
      JSON.stringify({
        verdicts: [{ criterionId: 'guide', verdict: 'maybe', reason: 'covered' }],
      }),
      JSON.stringify({
        verdicts: [
          { criterionId: 'guide', verdict: 'proven', reason: 'vibes' },
        ],
      }),
      JSON.stringify({ verdicts: [{ criterionId: '', verdict: 'proven', reason: 'covered' }] }),
    ]) {
      expect(parseThreadGoalJudgeReply(bad)).toBeNull()
    }
  })

  test('one malformed verdict rejects the whole reply', () => {
    // Accepting the good half would silently drop the criterion the model got
    // wrong, which reads as silence and therefore as not-proven anyway. Better
    // to retry the call than to act on a reply we only partly understood.
    const mixed = JSON.stringify({
      verdicts: [
        { criterionId: 'guide', verdict: 'proven', reason: 'covered' },
        { criterionId: 'notes', verdict: 'definitely', reason: 'covered' },
      ],
    })
    expect(parseThreadGoalJudgeReply(mixed)).toBeNull()
  })

  test('an empty verdict list is a valid reply, not a failure', () => {
    // It means "I proved nothing", which the caller turns into not-proven.
    expect(parseThreadGoalJudgeReply(JSON.stringify({ verdicts: [] }))).toEqual([])
  })
})
