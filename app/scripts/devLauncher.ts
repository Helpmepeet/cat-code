/**
 * Dev-launcher supervision decisions, kept pure so `dev.ts` stays wiring.
 *
 * `dev.ts` owns three child lifetimes (Vite, Electron, and the operator's
 * Ctrl-C) and previously supervised none of them: it polled a URL, exited 0
 * unconditionally, and never learned that a child had died. Every decision that
 * needed a test now lives here with injected clock/probe/kill, so the wiring
 * side has no branching left to get wrong.
 */

/** How a child process ended. Both fields null means "still running". */
export type ChildExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type ReadinessOutcome =
  | { ok: true }
  | { ok: false; reason: 'child-exited'; exit: ChildExit }
  | { ok: false; reason: 'timeout' }

/**
 * Shell convention for a signalled child. Anything we cannot map deterministically
 * becomes 1: a wrong-but-nonzero status still fails the shell, whereas guessing a
 * plausible number would misreport WHY.
 */
const SIGNAL_EXIT_BASE = 128
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
}

/**
 * The status `dev.ts` itself should exit with, given how Electron ended.
 * A launcher that always exits 0 (the pre-fix behaviour) makes a main-process
 * crash at startup indistinguishable from a clean quit to any caller — shell,
 * CI, or an operator reading `$?`.
 */
export function resolveLauncherExitCode(exit: ChildExit): number {
  if (exit.signal !== null) {
    const number = SIGNAL_NUMBERS[exit.signal]
    return number === undefined ? 1 : SIGNAL_EXIT_BASE + number
  }
  return exit.code ?? 1
}

/** A child that ended on its own terms: status 0 and no signal. */
export function isCleanExit(exit: ChildExit): boolean {
  return exit.code === 0 && exit.signal === null
}

/** Operator-facing one-liner for a child that ended unexpectedly. */
export function describeChildExit(name: string, exit: ChildExit): string {
  if (exit.signal !== null) return `${name} was killed by ${exit.signal}`
  return `${name} exited with status ${exit.code ?? 'unknown'}`
}

/**
 * Wait until the renderer dev server is genuinely OURS and reachable.
 *
 * The child-exit check runs BEFORE the probe on every pass, and that ordering is
 * the whole point. `vite.config.ts` sets `strictPort: true`, so a leftover Vite
 * from a previously killed run makes OUR Vite child exit immediately while the
 * stale server keeps answering on the same port. Probe-first (the pre-fix
 * behaviour) reads that as success and hands Electron a server from another run,
 * whose lifetime we do not control and whose config may not match this checkout.
 */
export async function waitForRendererReady(deps: {
  probe: () => Promise<boolean>
  /** The child's exit, or null while it is still running. */
  childExit: () => ChildExit | null
  now: () => number
  sleep: (ms: number) => Promise<void>
  timeoutMs: number
  pollMs: number
}): Promise<ReadinessOutcome> {
  const start = deps.now()
  for (;;) {
    const exit = deps.childExit()
    if (exit) return { ok: false, reason: 'child-exited', exit }

    if (await deps.probe()) return { ok: true }

    // Re-check after the probe: a child that died DURING the probe must be
    // reported as such, never as a timeout.
    const exitAfterProbe = deps.childExit()
    if (exitAfterProbe) {
      return { ok: false, reason: 'child-exited', exit: exitAfterProbe }
    }

    if (deps.now() - start > deps.timeoutMs) return { ok: false, reason: 'timeout' }
    await deps.sleep(deps.pollMs)
  }
}

/**
 * Stop a child with bounded escalation: SIGTERM, a grace window, then SIGKILL.
 *
 * The pre-fix launcher called `child.kill()` and exited immediately, so a child
 * that ignored or outlived SIGTERM was simply abandoned to the operator's
 * machine. Callers must await this before exiting.
 */
export async function terminateChild(deps: {
  kill: (signal: NodeJS.Signals) => void
  hasExited: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  graceMs: number
  pollMs: number
}): Promise<'already-exited' | 'terminated' | 'killed'> {
  if (deps.hasExited()) return 'already-exited'

  deps.kill('SIGTERM')
  const start = deps.now()
  while (deps.now() - start < deps.graceMs) {
    if (deps.hasExited()) return 'terminated'
    await deps.sleep(deps.pollMs)
  }
  if (deps.hasExited()) return 'terminated'

  deps.kill('SIGKILL')
  return 'killed'
}

/**
 * The readiness failure, as the operator needs to read it. The stale-server case
 * gets the actionable line because it is the one with a non-obvious cause and a
 * one-command fix.
 */
export function describeReadinessFailure(
  outcome: Exclude<ReadinessOutcome, { ok: true }>,
  url: string,
): string {
  if (outcome.reason === 'timeout') {
    return `[dev] the renderer dev server did not come up at ${url}; not launching Electron.`
  }
  return (
    `[dev] the renderer dev server ${describeChildExit('(vite)', outcome.exit)} ` +
    `before it was ready; not launching Electron.\n` +
    `[dev] a server already listening on that port is the usual cause ` +
    `(strictPort is on, so a leftover Vite from an earlier run makes this one exit). ` +
    `Check with: lsof -ti:5173`
  )
}
