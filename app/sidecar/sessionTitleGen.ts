/**
 * P4-6 title-rider — the GENERATION half (wired 2026-07-14).
 *
 * A fresh desktop session opens with `descriptor.title === null`, so the sidebar
 * and tab fall back to the cwd basename. The TUI already fills that gap
 * (`REPL.tsx:3032-3042`): it feeds the first user message to
 * `generateSessionTitle` (Haiku, sentence-case) and, if no custom title exists,
 * persists the result with `saveAiGeneratedTitle`. This module runs the SAME
 * machinery from the sidecar — never a re-implementation (mistakes #1/#10).
 *
 * The generator is a tiny one-shot state machine so the sidecar seam stays thin
 * and the policy (fresh-only, no-clobber, run-once, empty-prompt skip) is
 * unit-tested against injected deps — a live-path proof, not a shape test. The
 * real deps (`realSessionTitleDeps`) are the only place that touches engine
 * modules, so a test never needs the Haiku round-trip or a config home.
 */

import type { UUID } from 'crypto'
import { asSessionId } from '../../src/types/ids.js'
import { generateSessionTitle } from '../../src/utils/sessionTitle.js'
import {
  getCurrentSessionTitle,
  saveAiGeneratedTitle,
} from '../../src/utils/sessionStorage.js'

export type SessionTitleDeps = {
  /** Generate a title from the first prompt (Haiku); null on failure/empty. */
  generate: (prompt: string, signal: AbortSignal) => Promise<string | null>
  /**
   * True if the session already carries a real (custom) title — mirror the TUI's
   * guard (`REPL.tsx:3039`) so a generated title never clobbers a user rename.
   */
  hasExistingTitle: (engineSessionId: string) => boolean
  /** Persist the AI title to the engine transcript (durable + Sessions catalog). */
  persist: (engineSessionId: string, title: string) => void
}

/**
 * The real deps — the engine machinery the TUI uses. An engine session id IS a
 * uuid; the two setters brand it differently (`getCurrentSessionTitle` takes the
 * engine's `SessionId` via `asSessionId`, `saveAiGeneratedTitle` takes
 * `crypto.UUID` — the same cast `REPL.tsx:3042` makes).
 */
export const realSessionTitleDeps: SessionTitleDeps = {
  generate: generateSessionTitle,
  hasExistingTitle: engineSessionId =>
    Boolean(getCurrentSessionTitle(asSessionId(engineSessionId))),
  persist: (engineSessionId, title) =>
    saveAiGeneratedTitle(engineSessionId as UUID, title),
}

export type SessionTitleGenerator = {
  /**
   * Run at most once, after the first durable input of a FRESH session. On success it
   * persists the title (durable) and invokes `onTitle` so the caller can push it
   * live. Never throws; a resumed session, an existing title, an empty prompt, or
   * a null generation result all resolve to a silent no-op.
   */
  maybeGenerate(
    firstPrompt: string,
    onTitle: (title: string) => void,
  ): Promise<void>
}

export function createSessionTitleGenerator(opts: {
  /** The engine transcript id (persistence key); null disables generation. */
  engineSessionId: string | null
  /** A resumed session already has history + (usually) a title — never retitle it. */
  resumed: boolean
  /** Override the engine deps in tests; defaults to `realSessionTitleDeps`. */
  deps?: SessionTitleDeps
}): SessionTitleGenerator {
  const deps = opts.deps ?? realSessionTitleDeps
  let attempted = false
  return {
    async maybeGenerate(firstPrompt, onTitle) {
      // Run-once: the guard flips even on an early return, so a second turn never
      // re-attempts generation (the title is derived from the FIRST prompt only).
      if (attempted) return
      attempted = true

      if (opts.resumed || !opts.engineSessionId) return
      if (deps.hasExistingTitle(opts.engineSessionId)) return

      const trimmed = firstPrompt.trim()
      if (!trimmed) return

      let title: string | null = null
      try {
        title = await deps.generate(trimmed, new AbortController().signal)
      } catch {
        // generateSessionTitle already swallows + returns null; this is a belt so
        // a deps override can never throw out of the caller's background task.
        title = null
      }
      // A user can rename the session while the background title request is in
      // flight. Re-check immediately before writing or broadcasting so the
      // generated title never overwrites that live label.
      if (!title || deps.hasExistingTitle(opts.engineSessionId)) return

      try {
        deps.persist(opts.engineSessionId, title)
      } catch {
        // Persistence is best-effort (engine transcript write); still surface the
        // live title so the sidebar relabels this run even if the durable write failed.
      }
      onTitle(title)
    },
  }
}
