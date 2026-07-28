/**
 * Test-only child that writes session+done NDJSON in one stdout write.
 *
 * With `CATCODE_FIXTURE_FAIL_FIRST=1` the first item is emitted as a `failure`
 * record instead, standing in for a session the worker could not turn into a
 * valid result.
 */

import { PROTOCOL_VERSION } from '../shared/protocol.js'

async function main(): Promise<void> {
  const request = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
    items: Array<{ appSessionId: string; engineSessionId: string }>
  }
  const failFirst = process.env.CATCODE_FIXTURE_FAIL_FIRST === '1'
  const sessions = request.items.map((item, index) => {
    if (failFirst && index === 0) {
      return {
        type: 'failure',
        appSessionId: item.appSessionId,
        engineSessionId: item.engineSessionId,
        reason: 'invalid',
      }
    }
    return {
      type: 'session',
      appSessionId: item.appSessionId,
      engineSessionId: item.engineSessionId,
      frames: [
        {
          kind: 'event',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: item.appSessionId,
          replay: true,
          event: {
            type: 'message',
            message: {
              type: 'user',
              session_id: item.engineSessionId,
              uuid: '44444444-4444-4444-8444-444444444444',
              parent_tool_use_id: null,
              message: { role: 'user', content: 'fixture' },
            },
          },
        },
      ],
      // The boundary requires the key on every session record; this fixture
      // exercises framing/reaping, not derivation, so it sends all-nulls.
      runFacts: {
        model: null,
        permissionMode: null,
        effort: null,
        usedTokens: null,
        contextWindow: null,
      },
    }
  })
  process.stdout.write(
    `${sessions.map(session => JSON.stringify(session)).join('\n')}\n${JSON.stringify({ type: 'done', attempted: sessions.length })}\n`,
  )
  process.exit(0)
}

void main()
