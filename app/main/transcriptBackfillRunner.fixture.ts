/** Test-only child that writes session+done NDJSON in one stdout write. */

import { PROTOCOL_VERSION } from '../shared/protocol.js'

async function main(): Promise<void> {
  const request = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
    items: Array<{ appSessionId: string; engineSessionId: string }>
  }
  const item = request.items[0]!
  const session = {
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
            message: { role: 'user', content: 'fixture' },
          },
        },
      },
    ],
  }
  process.stdout.write(
    `${JSON.stringify(session)}\n${JSON.stringify({ type: 'done', attempted: 1 })}\n`,
  )
  process.exit(0)
}

void main()
