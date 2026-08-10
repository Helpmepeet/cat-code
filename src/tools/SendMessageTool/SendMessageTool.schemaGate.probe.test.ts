/**
 * Proves defect A's fix at the boundary that matters: the JSON Schema the
 * API request path actually sends for SendMessageTool's `message` field
 * (via zodToJsonSchema(), the same conversion `toolToAPISchema()` runs on
 * every request — see src/utils/zodToJsonSchema.ts). A test that only calls
 * validateInput() would pass even if the model still saw the structured
 * affordance in its tool schema, which is the bug this fixes
 * (docs/reports/2026-08-10-sendmessage-structured-message-schema-gate.md).
 *
 * Two real processes are required, not two in-process assertions:
 * SendMessageTool.inputSchema is built by buildTool()'s object-spread over
 * a `get inputSchema()` getter (src/Tool.ts buildTool), which forces the
 * lazySchema() factory to evaluate immediately at SendMessageTool.ts's
 * first import in the process — not deferred to first "real" access. Once
 * built, it is frozen for the process lifetime. SendMessageTool.test.ts
 * flips CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS at runtime in beforeEach,
 * after that first import already happened with teams off, so it can never
 * observe the opted-in schema shape. Only a process that has the env set
 * from launch can.
 */
import { describe, expect, test } from 'bun:test'
import { SCHEMA_MESSAGE_JSON_PREFIX } from './schemaGateProbeConstants.js'

const CHILD = new URL('./SendMessageTool.schemaGate.probe.child.ts', import.meta.url).pathname
const GROWTHBOOK_STUB = new URL('./agentTeamsGrowthbookStub.ts', import.meta.url).pathname

async function runChild(agentTeamsOptedIn: boolean): Promise<Record<string, unknown>> {
  const cmd = agentTeamsOptedIn
    ? [process.execPath, 'test', '--preload', GROWTHBOOK_STUB, CHILD]
    : [process.execPath, 'test', CHILD]
  const env: Record<string, string | undefined> = { ...process.env }
  // Both must be unset (not just falsy) for the "not opted in" child: a
  // real environment could otherwise have USER_TYPE=ant leaking through
  // from the parent, which short-circuits isAgentTeamsOptedIn() to true
  // regardless of CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS.
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  delete env.USER_TYPE
  if (agentTeamsOptedIn) {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  }
  const child = Bun.spawn({
    cmd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const line = stdout.split('\n').find(l => l.startsWith(SCHEMA_MESSAGE_JSON_PREFIX))
  if (exitCode !== 0 || !line) {
    throw new Error(
      `child process (agentTeamsOptedIn=${agentTeamsOptedIn}) failed to report its schema.\nexit=${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
  return JSON.parse(line.slice(SCHEMA_MESSAGE_JSON_PREFIX.length))
}

describe('SendMessageTool message schema, as generated for the API request', () => {
  test('without Agent Teams opted in, the schema offers plain text only', async () => {
    const messageSchema = await runChild(false)
    expect(messageSchema).toEqual({
      type: 'string',
      description: 'Plain text message content',
    })
    // The bug this guards against: the schema is a discriminated union that
    // includes shutdown_request even though the validator rejects it 100%
    // of the time without Agent Teams. Assert its absence by content, not
    // merely by matching the plain-string shape above.
    expect(JSON.stringify(messageSchema)).not.toContain('shutdown_request')
  })

  test('with Agent Teams opted in, the schema offers the structured-message union', async () => {
    const messageSchema = await runChild(true)
    expect(JSON.stringify(messageSchema)).toContain('shutdown_request')
    expect(messageSchema).toMatchObject({
      anyOf: [
        { type: 'string' },
        expect.anything(),
      ],
    })
  })
})
