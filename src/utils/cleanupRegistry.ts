/**
 * Global registry for cleanup functions that should run during graceful shutdown.
 * This module is separate from gracefulShutdown.ts to avoid circular dependencies.
 */

// Global registry for cleanup functions
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * Register a cleanup function to run during graceful shutdown.
 * @param cleanupFn - Function to run during cleanup (can be sync or async)
 * @returns Unregister function that removes the cleanup handler
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // Return unregister function
}

/**
 * Run all registered cleanup functions.
 * Used internally by gracefulShutdown.
 */
export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}

export type CleanupRunResult = {
  rejected: number
}

/**
 * Run every registered cleanup function and report only how many rejected.
 * Sidecar shutdown uses this when no individual cleanup is allowed to prevent
 * its peers from running.
 */
export async function runCleanupFunctionsSettled(): Promise<CleanupRunResult> {
  const results = await Promise.allSettled(
    Array.from(cleanupFunctions).map(cleanup => Promise.resolve().then(cleanup)),
  )
  return {
    rejected: results.filter(result => result.status === 'rejected').length,
  }
}

// ---------------------------------------------------------------------------
// Subagent stall sweep — tracks in-flight subagents and writes stall-detected
// terminal entries on parent exit for any that never received a terminal entry.
// ---------------------------------------------------------------------------

type ActiveSubagentEntry = {
  startedAt: number
  toolUseId: string
  transcriptPath: string
  agentType: string
  description: string
  sessionId: string
}

const activeSubagents = new Map<string, ActiveSubagentEntry>()

export function registerActiveSubagent(
  agentId: string,
  entry: ActiveSubagentEntry,
): void {
  activeSubagents.set(agentId, entry)
}

export function unregisterActiveSubagent(agentId: string): void {
  activeSubagents.delete(agentId)
}

/**
 * Transcript path the named subagent registered when it started, or `null` if
 * no live subagent owns that id. Registration happens on spawn (AgentTool) and
 * on resume (resumeAgent) and is dropped on terminal, so this is the agent-side
 * analogue of the main session's materialized transcript pointer: a diagnostic
 * appender can use it to write only to a transcript some live agent owns,
 * instead of deriving a path from an id that may own nothing.
 */
export function getActiveSubagentTranscriptPath(agentId: string): string | null {
  return activeSubagents.get(agentId)?.transcriptPath ?? null
}

/**
 * Called on process exit. For each subagent still in the map (no terminal entry
 * was written), read the last timestamp from its transcript, then append a
 * stall-detected terminal entry to the parent transcript.
 *
 * Must be synchronous — process.on('exit') handlers cannot await.
 */
export function flushStallDetectedEntries(parentTranscriptPath: string): void {
  if (activeSubagents.size === 0) return

  // Lazy require to avoid circular dependency: cleanupRegistry is imported by
  // sessionStorage (indirectly via gracefulShutdown), so a top-level import of
  // sessionStorage here would create a cycle. The require fires only at exit time,
  // well after all modules are fully initialized.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { appendSubagentTerminal, readFileTailSync } = require('./sessionStorage.js') as typeof import('./sessionStorage.js')

  const now = new Date().toISOString()

  for (const [agentId, info] of activeSubagents) {
    let lastActivityAt: string | undefined
    try {
      const tail = readFileTailSync(info.transcriptPath)
      const tsMatches = tail.match(/"timestamp":"([^"]+)"/g)
      if (tsMatches && tsMatches.length > 0) {
        const m = tsMatches[tsMatches.length - 1]!.match(/"timestamp":"([^"]+)"/)
        if (m?.[1]) lastActivityAt = m[1]
      }
    } catch {
      // transcript may not exist yet; leave lastActivityAt undefined
    }

    appendSubagentTerminal(parentTranscriptPath, {
      sessionId: info.sessionId,
      agentId: agentId as import('../types/ids.js').AgentId,
      toolUseId: info.toolUseId,
      status: 'stall-detected',
      reason: 'parent-exited-without-result',
      durationMs: Date.now() - info.startedAt,
      endedAt: now,
      ...(lastActivityAt && { lastActivityAt }),
    })
  }

  activeSubagents.clear()
}
