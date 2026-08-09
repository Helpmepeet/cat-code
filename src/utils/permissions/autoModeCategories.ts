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
  /** Normalized id when it matches a known rule, else undefined. */
  category: string | undefined
  /** The model's raw string, kept for telemetry even when unrecognized. */
  rawCategory: string | undefined
  recognized: boolean
}

/**
 * Resolve a reported category. Total by construction: every input yields a
 * value, and none of them can express "reject this verdict".
 */
export function resolveAutoModeCategory(
  raw: string | undefined,
  knownIds: ReadonlySet<string>,
): ResolvedAutoModeCategory {
  if (raw === undefined || raw.trim() === '') {
    return { category: undefined, rawCategory: undefined, recognized: false }
  }
  const normalized = normalizeAutoModeCategory(raw)
  if (knownIds.has(normalized)) {
    return { category: normalized, rawCategory: raw, recognized: true }
  }
  // Unrecognized: a user-authored rule, or a name the model invented. Either
  // way the verdict stands; only the label is dropped.
  return { category: undefined, rawCategory: raw, recognized: false }
}
