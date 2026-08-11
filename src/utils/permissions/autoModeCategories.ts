/**
 * Category handling for the ported auto-mode verdict.
 *
 * The category names which rule fired. It is **advisory** — telemetry and
 * grouping — and must never influence whether an action is blocked.
 *
 * Upstream is the precedent: its parser resolves the category with
 * `y$o.has(r) ? r : void 0`, so an unrecognized value is dropped and the block
 * still stands. Promoting the category to a required schema enum instead makes
 * an unrepresentable value a validation failure, and under "an unnameable block
 * is not a block" that failure degrades into an unsafe ALLOW. Two shapes cannot
 * be named by a fixed enum at all: an ordinary allow, which names no rule, and a
 * user-authored rule, since `autoMode.soft_deny` accepts arbitrary prose.
 *
 * So: parse the category, resolve it if we can, and never let either step reach
 * the block decision.
 */

/**
 * Read the category out of raw tool input without letting it near the core
 * verdict parse.
 *
 * This is the second layer of a deliberately two-layer parse. The core
 * (`thinking`, `shouldBlock`, `reason`) is validated on its own; if the category
 * were validated alongside it, a malformed value — a number, an object — would
 * fail the whole parse, and a failed parse fails closed to `shouldBlock: true`.
 * A junk label would then convert an ALLOW into a BLOCK, manufacturing exactly
 * the over-blocking this port exists to remove.
 *
 * So malformed category data is simply absent.
 */
export function readRawAutoModeCategory(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return undefined
  return (input as Record<string, unknown>).category
}

export function hasAutoModeCategory(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  return Object.hasOwn(input, 'category')
}

export function isAutoModeVerdictCategoryValid(
  shouldBlock: boolean,
  input: unknown,
): boolean {
  return shouldBlock || !hasAutoModeCategory(input)
}

/** Upstream's slug rule: lowercase, non-alphanumerics collapse to underscores. */
export function normalizeAutoModeCategory(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Derive the known rule ids from the vendored inventory.
 *
 * Taken from the template rather than a hand-maintained list so the ids cannot
 * drift from the rules actually in the prompt. A rule bullet opens with its
 * name, then either a consent-bar bracket or a colon:
 *   `- Data Exfiltration: …`
 *   `- Git Destructive [named+specifics — **must name:** …]: …`
 */
/**
 * Split one substitution block into whole rules.
 *
 * Upstream rules span multiple lines and carry nested `- **…**` sub-bullets
 * that belong to the rule above them. Treating every `- ` line as a rule
 * miscounts: the single hard-deny rule reads as four. A new rule starts only at
 * a bullet whose name is capitalised and terminated by `:` or a consent-bar
 * bracket; everything after it is that rule's body.
 */
export function extractAutoModeRuleEntries(
  permissionsTemplate: string,
  tagName: string,
): string[] {
  const block = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`).exec(
    permissionsTemplate,
  )?.[1]
  if (!block) return []
  const isRuleStart = (line: string): boolean =>
    /^- [A-Z][^:\n[]{2,70}[:[]/.test(line)
  const rules: string[] = []
  for (const line of block.split('\n')) {
    if (isRuleStart(line)) rules.push(line.slice(2))
    else if (rules.length > 0 && line.trim() !== '')
      rules[rules.length - 1] += `\n${line}`
  }
  return rules
}

export function extractAutoModeRuleIds(
  permissionsTemplate: string,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const tag of [
    'user_hard_deny_rules_to_replace',
    'user_soft_deny_rules_to_replace',
  ]) {
    const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(
      permissionsTemplate,
    )?.[1]
    if (!block) continue
    for (const match of block.matchAll(
      /(?:^|\n)- ([A-Z][^:\n[]{2,70})[:[]/g,
    )) {
      ids.add(normalizeAutoModeCategory(match[1]!))
    }
  }
  return ids
}

export type ResolvedAutoModeCategory = {
  category: AutoModeCategory | undefined
}

export type AutoModeCategory = {
  kind: 'built_in'
  id: string
}

/**
 * Resolve a reported category. Total by construction: every input yields a
 * value, and none of them can express "reject this verdict".
 */
export function resolveAutoModeCategory(
  raw: unknown,
  knownIds: ReadonlySet<string>,
): ResolvedAutoModeCategory {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    raw.kind === 'built_in' &&
    typeof raw.id === 'string' &&
    knownIds.has(raw.id)
  ) {
    return { category: { kind: 'built_in', id: raw.id } }
  }
  return { category: undefined }
}
