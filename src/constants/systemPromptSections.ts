import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'

type ComputeFn = () => string | null | Promise<string | null>

/**
 * The captured inputs that decide a section's computed bytes.
 *
 * Only values that can differ between two `getSystemPrompt()` calls in the
 * same process belong here — the arguments the caller passed and the locals
 * derived from them. Three categories deliberately stay OUT:
 *
 * - **GrowthBook / feature values.** Damping mid-session flag flips is
 *   intentional (`prompts.ts` verification-agent gate; cf. `Tool.ts:304`,
 *   `tools/AgentTool/forkSubagent.ts:64`). Keying on them would make a cold→warm
 *   flag transition rewrite the prompt mid-session, which is the behavior those
 *   comments exist to prevent. Note this damps more than gates: `frc` renders
 *   `keepRecent` from its remote config straight into the prompt text, so that
 *   value is frozen for the session too.
 * - **`language`.** Language is read once per session by contract; see the
 *   comment at its registration site in `prompts.ts`.
 * - **Anything that changes every turn.** A per-turn-varying input would grow
 *   the cache without bound and defeat prompt caching. Sections whose value is
 *   genuinely volatile use `DANGEROUS_uncachedSystemPromptSection` instead.
 *
 * Process state that drifts but is not a per-call argument (cwd, worktree) is
 * handled by the explicit `clearSystemPromptSections()` sites, not by the key.
 */
export type SectionKeyInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly SectionKeyInput[]
  | { readonly [field: string]: SectionKeyInput }

/** Declares a section whose output depends on no captured input. */
export const NO_SECTION_INPUTS: SectionKeyInput = null

type SystemPromptSection = {
  name: string
  cacheKey: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * Encode key inputs into an unambiguous string.
 *
 * Strings are length-prefixed and object fields are sorted, so two different
 * input trees can never encode to the same string — a collision would serve one
 * section's text under another's inputs.
 */
function encodeKeyInput(value: SectionKeyInput): string {
  if (value === null) return 'z'
  if (value === undefined) return 'u'
  if (typeof value === 'string') return `s${value.length}:${value}`
  if (typeof value === 'number') return `n${value};`
  if (typeof value === 'boolean') return value ? 'T' : 'F'
  if (Array.isArray(value)) {
    return `[${value.map(encodeKeyInput).join('')}]`
  }
  const fields = Object.entries(value as { [field: string]: SectionKeyInput })
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${fields
    .map(([field, fieldValue]) => `${field.length}:${field}${encodeKeyInput(fieldValue)}`)
    .join('')}}`
}

function sectionCacheKey(name: string, keyInputs: SectionKeyInput): string {
  // '#' separates, not '\0': a literal NUL in this file makes git classify it
  // binary and makes `rg` skip it during directory traversal, so the module
  // silently disappears from searches.
  //
  // The name is length-prefixed so the split stays unambiguous even if a
  // section name ever contains the separator. Without it, ('a', 'ab#z') and
  // ('a#s4:ab', null) both encode to "a#s4:ab#z" and share one entry, which
  // means one section served under another's inputs.
  return `${name.length}:${name}#${encodeKeyInput(keyInputs)}`
}

/**
 * Create a memoized system prompt section.
 *
 * Cached until /clear or /compact, per distinct `keyInputs`. Two calls that
 * captured different inputs get two entries rather than the first one's text —
 * pass every input the `compute` closure reads, or the second caller silently
 * receives the first caller's prompt.
 */
export function systemPromptSection(
  name: string,
  keyInputs: SectionKeyInput,
  compute: ComputeFn,
): SystemPromptSection {
  return {
    name,
    cacheKey: sectionCacheKey(name, keyInputs),
    compute,
    cacheBreak: false,
  }
}

/**
 * Create a volatile system prompt section that recomputes every turn.
 * This WILL break the prompt cache when the value changes.
 * Requires a reason explaining why cache-breaking is necessary.
 *
 * Takes no key inputs: it never reads the cache, so it cannot serve a stale
 * entry to begin with.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return {
    name,
    cacheKey: sectionCacheKey(name, NO_SECTION_INPUTS),
    compute,
    cacheBreak: true,
  }
}

/**
 * Resolve all system prompt sections, returning prompt strings.
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.cacheKey)) {
        return cache.get(s.cacheKey) ?? null
      }
      const value = await s.compute()
      // A cache-breaking section must not write either. Its entry is never read
      // back by itself, but a cached section registered later under the same
      // name and no key inputs would land on the identical key and serve this
      // volatile section's last value.
      if (!s.cacheBreak) {
        setSystemPromptSectionCacheEntry(s.cacheKey, value)
      }
      return value
    }),
  )
}

/**
 * Clear all system prompt section state. Called on /clear and /compact.
 * Also resets beta header latches so a fresh conversation gets fresh
 * evaluation of AFK/fast-mode/cache-editing headers.
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}

export const _forTest = {
  encodeKeyInput,
  sectionCacheKey,
}
