/**
 * P0-4 — Multi-session isolation probe (desktop-app migration, make-or-break #2).
 *
 * QUESTION: can two concurrent CatCode sessions share ONE engine process, or
 * does each session need its own process (N-process model)?
 *
 * THE RISK (verified vs. commit 234da9e):
 *   The engine keeps PROCESS-GLOBAL session/CWD state:
 *     - src/bootstrap/state.ts  STATE.cwd       (getCwdState :533 / setCwdState :537)
 *     - src/bootstrap/state.ts  STATE.sessionId (switchSession :474 / getSessionId :437)
 *   QueryEngine.submitMessage() mutates the global cwd per submit via
 *     setCwd(cwd)  at src/QueryEngine.ts:245  (→ setCwdState at state.ts:464/537).
 *   Two sessions in one process therefore write the SAME module-level singleton.
 *
 * PROOF CLASSIFICATION (F5 test-evidence follow-up): caller/wiring only.
 *
 * This file proves the deterministic one-process stomp and the controller's
 * per-instance permission routing. Its "two processes" rows deliberately use
 * `resetStateForTests()` as an in-process namespace simulation, so they are
 * NOT OS-process evidence: they cannot prove child lifecycle, signal delivery,
 * sockets, inherited resources, or a killed sidecar's survivor behavior.
 *
 * The real-process complement is
 * `app/sidecar/spawnConfig.probe.test.ts`: it uses the production
 * `SidecarSupervisor` to spawn real Bun sidecars over real Unix sockets,
 * including distinct-cwd isolation and kill-one/survivor liveness. GUI and
 * credentialed-live layers remain UNVERIFIED by both probes.
 *
 * WHAT THIS PROBE DOES (honest scope):
 *   It drives the REAL `AppSessionController` (the desktop seam — the same class
 *   the sidecar builders wrap) with a minimal adapter whose runTurn() performs
 *   the EXACT global mutations the real turn performs:
 *       setCwd(cwd)               // identical call to QueryEngine.ts:245
 *       switchSession(sessionId)  // identical global sessionId switch
 *   then yields (awaits) to let the other session interleave, then reads the
 *   globals back via getCwdState()/getSessionId() and reports what it observed.
 *   The controller's submit loop, event emission, and permission round-trip are
 *   ALL real engine code — only the model call is replaced by the global-state
 *   mutation that is the source of the risk.
 *
 *   It does NOT make a live model API call (needs credentials; adds nothing at
 *   THIS boundary — the stomp is a property of the shared module singleton, not
 *   of the model). This is stated so the result is not overclaimed.
 *
 * Reproduce:  bun test src/app-runtime/multiSessionIsolation.probe.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getCwdState,
  getSessionId,
  resetStateForTests,
  switchSession,
} from '../bootstrap/state.js'
import type { SessionId } from '../types/ids.js'
import { setCwd } from '../utils/Shell.js'
import { AppSessionController } from './AppSessionController.js'
import type { AppSessionControllerAdapter } from './AppSessionController.js'
import type { AppPermissionRequest } from './sessionEvents.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'

afterEach(() => {
  resetStateForTests()
})

// Two real, distinct, existing directories (setCwd realpath-validates existence).
function makeTwoDirs(): { dirA: string; dirB: string } {
  const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'p0-4-A-')))
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'p0-4-B-')))
  return { dirA, dirB }
}

/**
 * A barrier that both sessions await between "write the global" and "read the
 * global back". It forces the interleaving that two truly-concurrent turns
 * produce: A writes, B writes, then A reads (and sees B's write in 1-proc).
 */
function makeBarrier(n: number): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  return () => {
    arrived++
    if (arrived >= n) release()
    return gate
  }
}

type Observed = { seenCwd: string; seenSessionId: string }

/**
 * Adapter that reproduces the real per-submit global mutation
 * (setCwd + switchSession), interleaves via the barrier, then reads the
 * globals back and yields them so the assertion can inspect cross-talk.
 */
function isolationAdapter(args: {
  cwd: string
  sessionId: SessionId
  barrier: () => Promise<void>
  observed: Observed
}): AppSessionControllerAdapter {
  const { cwd, sessionId, barrier, observed } = args
  return {
    async *runTurn(): AsyncIterable<SDKMessage> {
      // === exactly what QueryEngine.submitMessage does at the top of a turn ===
      setCwd(cwd) // QueryEngine.ts:245 — mutates process-global STATE.cwd
      switchSession(sessionId) // mutates process-global STATE.sessionId
      // Let the OTHER concurrent session run its mutation before we read back.
      await barrier()
      // What does THIS session now observe in the process globals?
      observed.seenCwd = getCwdState()
      observed.seenSessionId = getSessionId()
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: `cwd=${observed.seenCwd} sid=${observed.seenSessionId}` },
          ],
        },
      } as SDKMessage
    },
  }
}

describe('P0-4 multi-session isolation', () => {
  test('ONE process, two concurrent sessions: globals STOMP (expected FAIL of isolation)', async () => {
    const { dirA, dirB } = makeTwoDirs()
    const sidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as SessionId
    const sidB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as SessionId

    const barrier = makeBarrier(2)
    const obsA: Observed = { seenCwd: '', seenSessionId: '' }
    const obsB: Observed = { seenCwd: '', seenSessionId: '' }

    // Two REAL controllers (the desktop seam), sharing the one process.
    const ctrlA = new AppSessionController(
      isolationAdapter({ cwd: dirA, sessionId: sidA, barrier, observed: obsA }),
    )
    const ctrlB = new AppSessionController(
      isolationAdapter({ cwd: dirB, sessionId: sidB, barrier, observed: obsB }),
    )

    // Run both turns concurrently in the SAME process.
    await Promise.all([ctrlA.submit('go'), ctrlB.submit('go')])

    // ISOLATION would require each session to still see its OWN cwd/sessionId.
    // In one process they share STATE.cwd/STATE.sessionId, so whichever wrote
    // last wins and BOTH sessions read the SAME value. Prove the leak:
    const isolated =
      obsA.seenCwd === dirA &&
      obsB.seenCwd === dirB &&
      obsA.seenSessionId === sidA &&
      obsB.seenSessionId === sidB

    // Document the actual leak for the report / re-runners.
    // eslint-disable-next-line no-console
    console.log('[P0-4 1-proc] A wanted', dirA, 'saw', obsA.seenCwd)
    // eslint-disable-next-line no-console
    console.log('[P0-4 1-proc] B wanted', dirB, 'saw', obsB.seenCwd)

    // The two sessions collapsed onto ONE shared cwd + ONE shared sessionId:
    expect(obsA.seenCwd).toBe(obsB.seenCwd) // both read the same global
    expect(obsA.seenSessionId).toBe(obsB.seenSessionId) // both read the same global
    // …which means at least one session is reading the OTHER's directory:
    expect(isolated).toBe(false) // ONE-PROCESS ISOLATION IS IMPOSSIBLE
  })

  test('ONE process: a permission request for A does NOT resolve B (per-controller state IS isolated)', async () => {
    // Nuance worth pinning: the permission ROUND-TRIP is per-controller
    // (pendingPermissionRequests is instance state on AppSessionController),
    // so cross-session permission delivery is fine. It is the process-GLOBAL
    // cwd/sessionId that breaks 1-proc, not the permission plumbing.
    const captured: Record<string, AppPermissionRequest | undefined> = {}
    function permAdapter(tag: string): AppSessionControllerAdapter {
      return {
        async *runTurn({ onPermissionRequest }): AsyncIterable<SDKMessage> {
          const req: AppPermissionRequest = {
            requestId: `req-${tag}`,
            request: { tool_name: 'Bash', input: {} } as never,
          }
          const resp = await onPermissionRequest(req)
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: `${tag}:${resp.behavior}` }] },
          } as SDKMessage
        },
      }
    }
    const ctrlA = new AppSessionController(permAdapter('A'))
    const ctrlB = new AppSessionController(permAdapter('B'))
    ctrlA.subscribe(e => {
      if (e.type === 'permission.requested') captured.A = e.request
    })
    ctrlB.subscribe(e => {
      if (e.type === 'permission.requested') captured.B = e.request
    })

    const runA = ctrlA.submit('go')
    const runB = ctrlB.submit('go')
    // Let both emit their permission.requested.
    await new Promise(r => setTimeout(r, 5))

    // Resolving A's request on ctrlA must NOT resolve B (different instance map).
    expect(ctrlB.respondToPermissionRequest('req-A', { behavior: 'allow', updatedInput: {} } as never)).toBe(false)
    expect(ctrlA.respondToPermissionRequest('req-A', { behavior: 'allow', updatedInput: {} } as never)).toBe(true)
    expect(ctrlB.respondToPermissionRequest('req-B', { behavior: 'deny', message: 'no' } as never)).toBe(true)
    await Promise.all([runA, runB])
    expect(captured.A?.requestId).toBe('req-A')
    expect(captured.B?.requestId).toBe('req-B')
  })

  test('TWO processes (simulated by per-process global reset): isolation HOLDS', async () => {
    const { dirA, dirB } = makeTwoDirs()
    const sidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as SessionId
    const sidB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as SessionId

    // "Process 1" owns only session A. Its globals never see B.
    async function runInFreshProcess(cwd: string, sid: SessionId): Promise<Observed> {
      resetStateForTests() // simulate a brand-new process's fresh module singleton
      const obs: Observed = { seenCwd: '', seenSessionId: '' }
      const barrier = makeBarrier(1) // no other session in this "process"
      const ctrl = new AppSessionController(
        isolationAdapter({ cwd, sessionId: sid, barrier, observed: obs }),
      )
      await ctrl.submit('go')
      return obs
    }

    // Sequential, each with its own reset = each session owns its process's globals.
    const obsA = await runInFreshProcess(dirA, sidA)
    const obsB = await runInFreshProcess(dirB, sidB)

    // Each session saw exactly its OWN cwd + sessionId. Zero cross-talk.
    expect(obsA.seenCwd).toBe(dirA)
    expect(obsA.seenSessionId).toBe(sidA)
    expect(obsB.seenCwd).toBe(dirB)
    expect(obsB.seenSessionId).toBe(sidB)
  })

  test('TWO processes: crash one, the OTHER survives + can restart', async () => {
    const { dirA, dirB } = makeTwoDirs()
    const sidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as SessionId
    const sidB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as SessionId

    // Model each session's process as an isolated global namespace. A crash =
    // that process's turn throws; it must NOT corrupt or abort the other's.
    resetStateForTests() // process B (survivor)
    const obsB: Observed = { seenCwd: '', seenSessionId: '' }
    const ctrlB = new AppSessionController(
      isolationAdapter({ cwd: dirB, sessionId: sidB, barrier: makeBarrier(1), observed: obsB }),
    )

    // process A crashes mid-turn.
    const crashingCtrl = new AppSessionController({
      // eslint-disable-next-line require-yield
      async *runTurn(): AsyncIterable<SDKMessage> {
        setCwd(dirA)
        switchSession(sidA)
        throw new Error('session A crashed')
      },
    })
    let aCrashed = false
    try {
      await crashingCtrl.submit('go')
    } catch {
      aCrashed = true
    }
    expect(aCrashed).toBe(true)

    // B (its own process) completes normally, unaffected by A's crash, and B's
    // globals are its own (A's crash left A's dir in A's process only).
    await ctrlB.submit('go')
    expect(obsB.seenCwd).toBe(dirB)
    expect(obsB.seenSessionId).toBe(sidB)

    // "Restart" A in a fresh process → clean isolated state again.
    resetStateForTests()
    const obsA2: Observed = { seenCwd: '', seenSessionId: '' }
    const ctrlA2 = new AppSessionController(
      isolationAdapter({ cwd: dirA, sessionId: sidA, barrier: makeBarrier(1), observed: obsA2 }),
    )
    await ctrlA2.submit('go')
    expect(obsA2.seenCwd).toBe(dirA)
    expect(obsA2.seenSessionId).toBe(sidA)
  })
})
