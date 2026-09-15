/**
 * Desktop MCP lifecycle acceptance probe.
 *
 * This starts the production sidecar through SidecarSupervisor with a disposable
 * project, local settings, and stdio MCP server. The real sidecar lifecycle,
 * MCP transport, discovery, trust gate, and shutdown path remain live.
 *
 * Run: bun test app/sidecar/mcpLifecycle.probe.test.ts
 */

import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import type { ServerFrame } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, 'index.ts')
const TEST_TIMEOUT_MS = 120_000

let supervisor: SidecarSupervisor | null = null
const tempRoots: string[] = []
const ownedFixturePids = new Set<number>()

afterEach(async () => {
  supervisor?.shutdown()
  supervisor = null
  await reapOwnedFixtures()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createFixtureProject(): {
  configHome: string
  eventsPath: string
  fixtureServer: string
  project: string
} {
  const root = mkdtempSync(join(tmpdir(), 'catcode-mcp-lifecycle-'))
  tempRoots.push(root)
  const project = join(root, 'project')
  const configHome = join(root, 'config')
  const eventsPath = join(root, 'fixture-events.log')
  const fixtureServer = join(root, 'mcp-fixture.ts')
  mkdirSync(join(project, '.cat-code'), { recursive: true })
  mkdirSync(configHome, { recursive: true })
  writeFileSync(join(configHome, '.cat-code.json'), '{}')

  writeFileSync(
    join(project, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        lifecycleFixture: {
          command: 'bun',
          args: ['run', fixtureServer, eventsPath],
        },
      },
    }),
  )
  writeFileSync(
    join(project, '.cat-code', 'settings.local.json'),
    JSON.stringify({
      enabledMcpjsonServers: ['lifecycleFixture'],
      model: 'claude-haiku-4-5-20251001',
    }),
  )
  writeFileSync(
    fixtureServer,
    `import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const eventsPath = process.argv[2]
if (!eventsPath) throw new Error('fixture events path is required')
writeFileSync(eventsPath, 'pid:' + process.pid + '\\n')

const reply = (id: unknown, result: unknown) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line) as { id?: unknown; method?: unknown }
  if (typeof message.method !== 'string' || message.id === undefined) continue
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lifecycle-fixture', version: '1.0.0' },
    })
    continue
  }
  if (message.method === 'tools/list') {
    appendFileSync(eventsPath, 'list\\n')
    reply(message.id, {
      tools: [{
        name: 'ping',
        description: 'Returns deterministic fixture content.',
        inputSchema: { type: 'object', properties: {} },
      }],
    })
    continue
  }
  if (message.method === 'tools/call') {
    appendFileSync(eventsPath, 'call\\n')
    reply(message.id, { content: [{ type: 'text', text: 'pong' }] })
  }
}
`,
  )
  return { configHome, eventsPath, fixtureServer, project }
}

function fixtureEvents(eventsPath: string): string[] {
  if (!existsSync(eventsPath)) return []
  return readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean)
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`)
    }
    await Bun.sleep(25)
  }
}

function fixturePid(events: string[]): number {
  const line = events.find(event => event.startsWith('pid:'))
  const pid = line ? Number(line.slice('pid:'.length)) : Number.NaN
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error(`fixture did not record a valid pid: ${events.join(', ')}`)
  }
  ownedFixturePids.add(pid)
  return pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function reapOwnedFixtures(): Promise<void> {
  const deadline = Date.now() + 5_000
  while ([...ownedFixturePids].some(isAlive) && Date.now() < deadline) {
    await Bun.sleep(25)
  }
  for (const pid of ownedFixturePids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The sidecar cleanup path may have reaped it between check and kill.
      }
    }
  }
  ownedFixturePids.clear()
}

test(
  'sidecar starts approved MCP only after socket readiness and workspace trust, then discovers its tool',
  async () => {
    const { configHome, eventsPath, project } = createFixtureProject()
    const frames: ServerFrame[] = []

    supervisor = new SidecarSupervisor({
      sidecarCommand: 'bun',
      sidecarArgs: ['run', sidecarEntry],
      sidecarCwd: project,
      sidecarEnv: {
        CLAUDE_CONFIG_DIR: configHome,
        CATCODE_SIDECAR_RESUME_SESSION_ID: '',
        // The sidecar must exercise the production trust store. Under the Bun
        // test runner's NODE_ENV=test shortcut, trust writes and trust reads use
        // distinct in-memory fixtures and cannot observe each other.
        NODE_ENV: 'production',
      },
    })
    const unsubscribe = supervisor.subscribe((event: SupervisorEvent) => {
      if (event.type === 'frame') frames.push(event.frame)
    })
    const sessionId = supervisor.spawnSession('mcp-lifecycle-probe')

    await waitFor(
      () => frames.some(frame => frame.kind === 'ready'),
      'sidecar readiness',
    )
    await waitFor(
      () =>
        frames.some(
          frame =>
            frame.kind === 'workspace-trust.snapshot' &&
            frame.workspaceTrust.trusted === false,
        ),
      'untrusted workspace snapshot',
    )

    // The lifecycle is prepared at normal engine startup, but the fixture command
    // must not spawn until the real socket-ready + trust gate both pass.
    await Bun.sleep(300)
    expect(fixtureEvents(eventsPath)).toEqual([])

    supervisor.send(sessionId, {
      type: 'workspace.trust',
      requestId: 'mcp-lifecycle-trust',
    })
    await waitFor(
      () =>
        frames.some(
          frame =>
            frame.kind === 'workspace.trust.result' &&
            frame.requestId === 'mcp-lifecycle-trust',
        ),
      'workspace trust acceptance',
    )
    const trustResult = frames.find(
      frame =>
        frame.kind === 'workspace.trust.result' &&
        frame.requestId === 'mcp-lifecycle-trust',
    )
    expect(trustResult).toMatchObject({
      kind: 'workspace.trust.result',
      ok: true,
    })
    await waitFor(
      () =>
        frames.some(
          frame =>
            frame.kind === 'workspace-trust.snapshot' &&
            frame.workspaceTrust.trusted === true,
        ),
      'trusted workspace snapshot',
    )
    await waitFor(
      () => fixtureEvents(eventsPath).includes('list'),
      'MCP tool discovery after workspace trust',
    )

    const pid = fixturePid(fixtureEvents(eventsPath))
    expect(isAlive(pid)).toBe(true)

    supervisor.shutdown()
    supervisor = null
    await waitFor(() => !isAlive(pid), 'fixture subprocess shutdown', 15_000)
    unsubscribe()
  },
  TEST_TIMEOUT_MS,
)
