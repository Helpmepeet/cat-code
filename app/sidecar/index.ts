/**
 * Headless Bun engine sidecar — entrypoint (net-new, small).
 *
 * Run as its own OS process by the supervisor (Electron-free). It:
 *   1. builds a real QueryEngine-backed `AppSessionController` for normal
 *      startup, or the P1-0 fixture controller only when explicitly requested;
 *   2. listens on a Unix-domain socket (D6 pin 1) at the path handed to it;
 *   3. raw-forwards controller events and validates inbound frames via
 *      `SidecarServer`.
 *
 * `CATCODE_SIDECAR_PROBE=1` retains the P1-0 transport fixture: it submits one
 * probe prompt on first attach so tests can verify raw `tool_use` forwarding.
 * Normal Electron startup does not set that flag and never emits the fixture.
 *
 * ZERO `electron` imports. This is a plain Bun program.
 */

import { chmodSync, statSync } from 'node:fs'

import { FrameDecoder } from '../shared/framing.js'
import {
  MAX_FRAME_BYTES,
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
  PARKED_EXIT_CODE,
  RESUME_BUSY_EXIT_CODE,
  RESUME_FAILED_EXIT_CODE,
} from '../shared/limits.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import { getCwd } from '../../src/utils/cwd.js'
import { getUserSpecifiedModelSetting } from '../../src/utils/model/model.js'
import type { Message } from '../../src/types/message.js'
import { processSessionStartHooks } from '../../src/utils/sessionStart.js'
import {
  getTranscriptPath,
  loadDisplayTranscriptFromJsonlPath,
} from '../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import {
  mergeDisplayHistoryWithSeed,
  projectUndeliveredPrompts,
  projectResumedHistory,
} from './historyProjection.js'
import { initializeSidecarRuntime } from './initializeRuntime.js'
import {
  createSidecarSessionController,
  loadAgentDefinitionsForRuntime,
  readSpawnModel,
} from './sessionController.js'
import { withRestoredSubagentHistory } from './subagentHistory.js'
import {
  resumeEngineSession,
  SidecarResumeBusyError,
  SidecarResumeError,
} from './sessionResume.js'
import { SidecarServer } from './sidecarServer.js'
import { setPeerHostRequester } from './peerHostRequester.js'
import { createBackpressuredSocket } from './backpressuredSocket.js'
import { createSidecarOperationalLogger } from './operationalLogger.js'
import type { SidecarOperationalLogger } from './operationalLogger.js'

/**
 * CC-3 — idle self-exit TTL (docs O1 / SESSION-LIFETIME §2). A sidecar whose
 * supervisor died (host crash) is orphaned: the socket outlives the parent and
 * nothing reaps it until the next app launch — and never, if its registry row is
 * evicted first. This bounds that lifetime: with no active supervisor connection
 * for this long, the sidecar exits cleanly (unlinks its socket, exit 0). Generous
 * by default so a live, merely-quiet session is never reaped; a live connection
 * cancels the timer regardless of idle time. Overridable via
 * `CATCODE_SIDECAR_IDLE_TTL_MS` (tests shrink it). This is additive time-based
 * self-exit, NOT parent-binding — die-with-window (SESSION-LIFETIME L2) remains
 * supervisor behavior; crash-restore is unaffected (it re-spawns through
 * `host.restoreSession` → `sessionResume.ts`, never attaching to an orphan).
 */
const DEFAULT_SIDECAR_IDLE_TTL_MS = 15 * 60 * 1000

let activeOperationalLogger: SidecarOperationalLogger | null = null
let activeAppSessionId: string | undefined
let activeEngineSessionId: string | undefined
let fatalExitStarted = false

/** Persist only a closed fatal category before the sidecar terminates. */
function exitAfterFatal(error: unknown): void {
  if (fatalExitStarted) return
  fatalExitStarted = true
  const isResumeFailure = error instanceof SidecarResumeError
  const isResumeBusy = error instanceof SidecarResumeBusyError
  activeOperationalLogger?.write({
    level: 'fatal',
    event: isResumeFailure ? 'session.restore.failed' : 'app.fatal',
    ...(activeAppSessionId ? { appSessionId: activeAppSessionId } : {}),
    ...(activeEngineSessionId ? { engineSessionId: activeEngineSessionId } : {}),
    fields: {
      reason: isResumeBusy
        ? 'resume_busy'
        : isResumeFailure
          ? 'resume_failure'
          : 'uncaught_failure',
    },
  })
  // Retain raw stderr for an attached development terminal only. It is never
  // copied into the desktop operational descriptor.
  if (isResumeFailure) {
    process.stderr.write(
      `[sidecar] ${isResumeBusy ? 'resume-busy' : 'resume-failed'}: ${
        error instanceof Error ? error.message : 'unknown'
      }\n`,
    )
    process.exit(isResumeBusy ? RESUME_BUSY_EXIT_CODE : RESUME_FAILED_EXIT_CODE)
  }
  process.stderr.write(`[sidecar] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
}

process.on('uncaughtException', exitAfterFatal)
process.on('unhandledRejection', exitAfterFatal)

/**
 * Parse `CATCODE_SIDECAR_IDLE_TTL_MS`. A non-negative finite integer overrides
 * the default; `0` disables the timer; a missing/malformed value falls back to
 * the default (fail-safe: a typo never silently disables the janitor).
 */
function parseIdleTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_SIDECAR_IDLE_TTL_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SIDECAR_IDLE_TTL_MS
  return Math.floor(parsed)
}

type SidecarArgs = {
  socketPath: string
  sessionId: string
  /**
   * Caller-chosen session root (REGISTRY.md §7). Host-owned input (T8/HC1); the
   * supervisor also sets it as the child's spawn cwd, so the engine's project
   * identity is already rooted here. Validated below as defense in depth.
   */
  cwd: string
  /**
   * Optional engine session to resume (REGISTRY.md R3). Present ⇒ resume that
   * transcript through the engine's real machinery, never a fresh mint.
   */
  resumeEngineSessionId: string | undefined
  /** P1-0 only: inject the probe tool_use frame on first attach. */
  probeOnAttach: boolean
}

async function projectCurrentDisplayHistory(
  retainedMessages: Message[],
): Promise<{ history: ReturnType<typeof projectResumedHistory>; truncated: boolean }> {
  const seedHistoryEvents = projectResumedHistory(retainedMessages)
  const display = await loadDisplayTranscriptFromJsonlPath(getTranscriptPath(), {
    maxMessages: MAX_HISTORY_REPLAY_FRAMES,
    maxBytes: MAX_HISTORY_REPLAY_BYTES * 2,
  })
  const merged = mergeDisplayHistoryWithSeed(
    display.messages,
    seedHistoryEvents,
  )
  const history = await withRestoredSubagentHistory(
    getSessionId(),
    merged.history,
    message => process.stderr.write(`${message}\n`),
  )
  return {
    history,
    truncated: display.truncated || merged.truncated,
  }
}

function parseArgs(): SidecarArgs {
  const socketPath = process.env.CATCODE_SIDECAR_SOCKET
  const sessionId = process.env.CATCODE_SIDECAR_SESSION_ID
  if (!socketPath || !sessionId) {
    throw new Error(
      'sidecar requires CATCODE_SIDECAR_SOCKET and CATCODE_SIDECAR_SESSION_ID',
    )
  }
  const probeOnAttach = process.env.CATCODE_SIDECAR_PROBE === '1'
  // The cwd is required for a real session (the engine roots project identity on
  // it). Probe mode has no engine, so tolerate its absence there. Fail loudly on
  // a missing/non-directory cwd rather than silently booting somewhere wrong
  // (defense in depth behind the host's HC1 validation — this session never
  // trusts a renderer-authored path, but it does verify a host-supplied one).
  const cwd = process.env.CATCODE_SIDECAR_CWD
  if (!probeOnAttach) {
    if (!cwd) {
      throw new Error('sidecar requires CATCODE_SIDECAR_CWD')
    }
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      throw new Error(`CATCODE_SIDECAR_CWD is not a directory: ${cwd}`)
    }
  }
  return {
    socketPath,
    sessionId,
    cwd: cwd ?? process.cwd(),
    resumeEngineSessionId: process.env.CATCODE_SIDECAR_RESUME_SESSION_ID || undefined,
    probeOnAttach,
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  const operational = createSidecarOperationalLogger({ appSessionId: args.sessionId })
  activeOperationalLogger = operational
  activeAppSessionId = args.sessionId
  operational.write({
    level: 'info',
    event: 'process.started',
    appSessionId: args.sessionId,
    fields: { role: 'sidecar', pid: process.pid },
  })
  if (!args.probeOnAttach) {
    await initializeSidecarRuntime()
  }

  // Resume BEFORE reading the engine session id: processResumedConversation
  // adopts the resumed id via switchSession, so getSessionId() then returns it
  // and the ready frame's engineSessionId echoes the requested resume id. A bad
  // id throws here → the fatal handler below exits non-zero + loudly (never a
  // silent fresh session). Probe mode has no engine and cannot resume.
  // The loaded Message[] are the restored turn context (F1, host-plane review
  // 2026-07-05): they MUST reach the session controller below — id adoption
  // alone restores the transcript key, not the conversation.
  // The resumed engine and the QueryEngine it seeds must share one catalog.
  // Otherwise restoreAgentFromSession sees no custom agents while the new
  // controller discovers them later, silently dropping the recorded agent.
  const agentDefinitions = args.probeOnAttach
    ? undefined
    : await loadAgentDefinitionsForRuntime(args.cwd)
  let resumed: Awaited<ReturnType<typeof resumeEngineSession>> | undefined
  let resumedMessages: Message[] | undefined
  let turnInterrupted = false
  let undeliveredPrompts: Awaited<
    ReturnType<typeof resumeEngineSession>
  >['undeliveredPrompts'] = []
  // `agentDefinitions` is loaded exactly when this is not a probe attach, so
  // testing it here is the same condition and lets the resume call see a
  // defined catalog.
  if (agentDefinitions && args.resumeEngineSessionId) {
    resumed = await resumeEngineSession(
      args.resumeEngineSessionId,
      args.cwd,
      agentDefinitions,
    )
    resumedMessages = resumed.messages
    turnInterrupted = resumed.turnInterrupted
    undeliveredPrompts = resumed.undeliveredPrompts
    process.stderr.write(
      `[sidecar] resume-seeded messages=${resumed.messages.length} engineSessionId=${resumed.engineSessionId}\n`,
    )
    operational.write({
      level: 'info',
      event: 'session.restore.completed',
      appSessionId: args.sessionId,
      engineSessionId: resumed.engineSessionId,
      fields: {
        messageCount: resumed.messages.length,
        count: resumed.droppedQueueRecords,
      },
    })
  }
  // Resume may restore a persisted worktree and move the engine's cwd. All
  // sidecar catalogs/domains must use that post-resume cwd, not the stale
  // launch directory captured in args.
  const runtimeCwd = resumed ? getCwd() : args.cwd

  const engineSessionId = args.probeOnAttach
    ? `probe:${args.sessionId}`
    : getSessionId()
  activeEngineSessionId = engineSessionId

  // The fresh half of the same seam. A resumed session already ran its
  // SessionStart hooks — the engine's own loader fires the 'resume' source and
  // appends the results to the restored transcript
  // (`src/utils/conversationRecovery.ts:723-726`), so they arrive above inside
  // `resumedMessages`. A fresh session ran nothing at all, which silently
  // dropped every plugin- and settings-installed SessionStart hook the terminal
  // injects. This is the CLI's own call for a non-resume launch
  // (`src/main.tsx:2471-2474`), whose result the REPL takes as `initialMessages`
  // (`src/main.tsx:3874`). Probe mode has no engine, and running the user's
  // arbitrary shell there would be wrong besides.
  //
  // `agentType` is deliberately omitted rather than stubbed: nothing in the
  // desktop selects a main-thread agent, so the fallback
  // `processSessionStartHooks` already applies (`src/utils/sessionStart.ts:131`)
  // reports the same "no agent" the CLI reports for a launch without `--agent`.
  let startupHookMessages: Message[] | undefined
  if (!args.probeOnAttach && resumed === undefined) {
    // The exact value this session's model resolution selects moments from now:
    // `initializeSidecarModelProvider` takes the spawn model first and falls
    // back to `getUserSpecifiedModelSetting()` for a non-resumed session, so a
    // created peer reports the model it will actually run on rather than the
    // saved default (PEER-SESSIONS R7). It deliberately does not resolve a
    // default, so when the user has chosen no model there is none to report and
    // the field stays absent.
    const specifiedModel = readSpawnModel() ?? getUserSpecifiedModelSetting()
    const hookMessages = await processSessionStartHooks('startup', {
      ...(typeof specifiedModel === 'string' ? { model: specifiedModel } : {}),
    })
    if (hookMessages.length > 0) {
      startupHookMessages = hookMessages
    }
  }

  const {
    controller,
    permissions,
    settings,
    agentConfig,
    goals,
    memory,
    tasks,
    accounts,
    workspaceTrust,
    diagnostics,
    extensions,
    remoteSettings,
    agentMode,
    leases,
    taskControl,
    panelTaskReaper,
    runControls,
    sessionActions,
    contextBreakdown,
    slashCatalog,
  } = await createSidecarSessionController({
    probe: args.probeOnAttach,
    cwd: runtimeCwd,
    // Mutually exclusive by construction: a resume seeds the restored
    // transcript, whose tail already carries its own 'resume' hook messages; a
    // fresh session seeds the 'startup' hook messages computed just above.
    ...(resumedMessages !== undefined
      ? { initialMessages: resumedMessages }
      : startupHookMessages !== undefined
        ? { initialMessages: startupHookMessages }
        : {}),
    ...(agentDefinitions !== undefined ? { agentDefinitions } : {}),
    ...(resumed !== undefined ? { resumedInitialState: resumed.initialState } : {}),
  })

  // F2 (decisions/RESTORE-HISTORY.md): display history is an archival prefix
  // plus the exact visible model-seed tail. The compacted seed itself stays
  // unchanged; only the display loader follows logicalParentUuid across seams.
  // Both projections run AFTER resume so getSessionId() stamps the adopted id.
  let historyEvents: ReturnType<typeof projectResumedHistory> | undefined
  let historySourceTruncated = false
  if (resumedMessages !== undefined) {
    const projected = await projectCurrentDisplayHistory(resumedMessages)
    historyEvents = projected.history
    historyEvents.push(
      ...projectUndeliveredPrompts(undeliveredPrompts, getSessionId()),
    )
    historySourceTruncated = projected.truncated
  }

  const idleTtlMs = parseIdleTtlMs(process.env.CATCODE_SIDECAR_IDLE_TTL_MS)

  const server = new SidecarServer({
    sessionId: args.sessionId,
    engineSessionId,
    controller,
    ...(permissions ? { permissions } : {}),
    ...(settings ? { settings } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(goals ? { goals } : {}),
    ...(memory ? { memory } : {}),
    ...(tasks ? { tasks } : {}),
    ...(accounts ? { accounts } : {}),
    ...(workspaceTrust ? { workspaceTrust } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(extensions ? { extensions } : {}),
    ...(remoteSettings ? { remoteSettings } : {}),
    ...(agentMode ? { agentMode } : {}),
    ...(leases ? { leases } : {}),
    ...(taskControl ? { taskControl } : {}),
    ...(panelTaskReaper ? { panelTaskReaper } : {}),
    ...(runControls ? { runControls } : {}),
    ...(sessionActions ? { sessionActions } : {}),
    ...(contextBreakdown ? { contextBreakdown } : {}),
    ...(slashCatalog.length > 0 ? { slashCatalog } : {}),
    ...(historyEvents !== undefined ? { history: historyEvents } : {}),
    ...(historySourceTruncated ? { historySourceTruncated: true } : {}),
    projectHistory: projectCurrentDisplayHistory,
    ...(turnInterrupted ? { turnInterrupted: true } : {}),
    // P4-6 title-rider: a resumed session already has its title + history, so its
    // first turn this run is a continuation — never retitle it from that prompt.
    resumed: resumedMessages !== undefined,
    idleTtlMs,
    // Keep the raw ServerFrame intact inside a socket-only envelope. The
    // supervisor unwraps this before any host/renderer code sees the frame.
    // This stamps identity at the engine/sidecar boundary without introducing a
    // payload mapper or leaking frame content into diagnostics.
    wrapOutboundFrame: (frame, deliveryTrace) => ({
      kind: 'sidecar.delivery-envelope',
      frame,
      deliveryTrace,
    }),
    onDeliveryStage: (trace, stage, frameKind) => {
      operational.deliveryStage({
        sessionId: args.sessionId,
        trace,
        stage,
        frameKind,
      })
    },
    // A refused frame is the one loss the transcript cannot show: the session
    // just goes quiet. `warn` is load-bearing — it is what puts the record in
    // the anomaly shedding class rather than the sample one.
    onFrameDropped: (reason, frameKind) => {
      operational.write({
        level: 'warn',
        event: 'frame.dropped',
        appSessionId: args.sessionId,
        fields: { reason, frame: frameKind },
      })
    },
    // A1 — the turn lifecycle. `started`/`completed` are the pair that makes a
    // missing `completed` mean something; `stalled` is the once-per-turn record
    // for the case the pair alone cannot report while the process is still up.
    onTurnLifecycle: event => {
      if (event.kind === 'started') {
        operational.write({
          level: 'info',
          event: 'session.turn.started',
          appSessionId: args.sessionId,
          engineSessionId,
        })
        return
      }
      if (event.kind === 'completed') {
        operational.write({
          level: 'info',
          event: 'session.turn.completed',
          appSessionId: args.sessionId,
          engineSessionId,
          fields: { durationMs: event.durationMs, reason: event.outcome },
        })
        return
      }
      // `warn` is load-bearing exactly as it is on `frame.dropped`: it puts the
      // record in the anomaly shedding class rather than the sample one, and a
      // start marker shed under load is worth nothing (CC-45).
      operational.write({
        level: 'warn',
        event: 'session.turn.stalled',
        appSessionId: args.sessionId,
        engineSessionId,
        fields: { phase: event.phase, elapsedMs: event.elapsedMs },
      })
    },
    log: line => operational.legacy(line),
    // CC-3 — the idle janitor: clean up the socket like the signal handlers do,
    // then exit 0 (a clean, expected shutdown — not a crash). `cleanup` is the
    // same closure the SIGTERM/SIGINT handlers use; it is defined just below and
    // only invoked here asynchronously by the timer, so it is initialized by the
    // time this fires.
    onIdle: () => {
      void exitCleanly(0)
    },
    // IDLE-PARK (decisions/IDLE-PARK.md §2/§3) — the gated park exit. The sidecar
    // owns the gate + latch; when it decides to park it flushes the socket and
    // self-exits with the dedicated PARKED_EXIT_CODE so the host can classify the
    // exit as a park (not a crash) purely from the code — no ack frame. Same
    // `cleanup` closure the SIGTERM/onIdle paths use (defined just below and only
    // invoked here asynchronously, so it is initialized by the time this fires).
    onPark: () => {
      void exitCleanly(PARKED_EXIT_CODE)
    },
  })

  // HOST-REQUEST-PLANE — point the peer tools at the live request client. The
  // tools were built with the session controller above, before this server
  // existed, so they resolve a requester per call rather than holding one; this
  // is where the one that exists is published.
  setPeerHostRequester((verb, args) => server.requestHost(verb, args))

  // `Bun.listen({ unix })` is the Unix-domain socket transport (D6 pin 1: a
  // socket FILE, not a listening TCP port — no network surface added).
  const bunListen = (globalThis as { Bun?: typeof import('bun') }).Bun?.listen
  if (!bunListen) {
    throw new Error('sidecar must run under Bun (Bun.listen unavailable)')
  }

  // A stale socket file (e.g. from a crashed prior run) blocks bind; remove it.
  try {
    require('fs').unlinkSync(args.socketPath)
  } catch {
    // not present — fine
  }

  bunListen({
    unix: args.socketPath,
    socket: {
      open(socket) {
        // Bun's socket.write() can accept fewer bytes than given once the send
        // buffer fills; the raw wrapper used to discard that short count, which
        // silently truncated any frame over ~8 KiB and desynced the length-
        // prefixed stream. This wrapper queues the remainder and flushes it on
        // `drain` (see backpressuredSocket.ts).
        const { wrapper, drain } = createBackpressuredSocket(socket, {
          onOverflow: queuedBytes => {
            process.stderr.write(
              `[sidecar] outbound queue overflow (${queuedBytes} bytes), dropping connection\n`,
            )
            operational.write({
              level: 'warn',
              event: 'diagnostic',
              appSessionId: args.sessionId,
              engineSessionId,
              fields: { source: 'socket', queuedBytes, reason: 'outbound_overflow' },
            })
          },
        })
        const connection = server.addConnection(wrapper)
        // Stash per-socket state so data/close/drain can find its connection.
        socketState.set(socket, { connection, decoder: connection.decoder, drain })

        if (args.probeOnAttach) {
          // P1-0 gate: drive the real controller so its emit()/subscribe() path
          // ships the tool_use frame. Fire-and-forget; errors surface as an
          // error frame via the server's submit path.
          void controller
            .submit('__p1_0_probe__')
            .catch(error => {
              process.stderr.write(
                `[sidecar] probe submit failed: ${
                  error instanceof Error ? error.message : String(error)
                }\n`,
              )
            })
        }
      },
      drain(socket) {
        const state = socketState.get(socket)
        if (!state) return
        try {
          state.drain()
        } catch (error) {
          process.stderr.write(
            `[sidecar] drain failed, dropping connection: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          )
          server.removeConnection(state.connection)
          socketState.delete(socket)
        }
      },
      data(socket, chunk) {
        const state = socketState.get(socket)
        if (state) {
          server.handleData(state.connection, toBuffer(chunk))
        }
      },
      close(socket) {
        const state = socketState.get(socket)
        if (state) {
          server.removeConnection(state.connection)
          socketState.delete(socket)
        }
      },
      error(socket, error) {
        process.stderr.write(
          `[sidecar] socket error: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
        const state = socketState.get(socket)
        if (state) {
          server.removeConnection(state.connection)
          socketState.delete(socket)
        }
      },
    },
  })

  // The supervisor's random parent directory authenticates path ownership;
  // this closes the second leg by preventing other local users from connecting
  // when a permissive umask would otherwise create a world-readable socket.
  chmodSync(args.socketPath, 0o600)

  process.stderr.write(
    `[sidecar] READY sessionId=${args.sessionId} socket=${args.socketPath}\n`,
  )
  operational.write({
    level: 'info',
    event: 'sidecar.ready',
    appSessionId: args.sessionId,
    engineSessionId,
    fields: { pid: process.pid },
  })

  // Clean the socket file on exit so a restart can re-bind the path.
  const cleanup = () => {
    server.close()
    try {
      require('fs').unlinkSync(args.socketPath)
    } catch {
      // best-effort
    }
  }
  let cleanExitStarted = false
  const exitCleanly = async (code: number): Promise<void> => {
    if (cleanExitStarted) return
    cleanExitStarted = true
    cleanup()
    await releaseActiveTranscriptLease().catch(error => {
      const detail = (error instanceof Error ? error.message : String(error)).slice(
        0,
        512,
      )
      process.stderr.write(
        `[sidecar] transcript lease release failed during clean exit: ${detail}\n`,
      )
    })
    process.exit(code)
  }
  process.on('SIGTERM', () => {
    void exitCleanly(0)
  })
  process.on('SIGINT', () => {
    void exitCleanly(0)
  })
}

// Per-socket association: Bun's socket handlers receive the raw socket, so we
// map it to its `SidecarServer` connection + decoder. `FrameDecoder` is unused
// directly here (the connection owns it) but kept in the type for clarity.
const socketState = new WeakMap<
  object,
  {
    connection: ReturnType<SidecarServer['addConnection']>
    decoder: FrameDecoder
    drain: () => void
  }
>()

function toBuffer(chunk: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

void main().catch(exitAfterFatal)
