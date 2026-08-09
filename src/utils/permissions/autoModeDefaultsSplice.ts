/**
 * Upstream Claude Code's `$defaults` splice semantics (verified against 2.1.223).
 *
 * A user rule list REPLACES the shipped defaults, unless it contains the literal
 * `$defaults` — which expands to the shipped block at that position, at most
 * once however many times it appears. With no user list at all, the defaults
 * stand unchanged.
 *
 * This exists because the external template wraps its defaults INSIDE the
 * `<user_*_to_replace>` tags, so a plain replace silently deletes every shipped
 * rule — secrets, sudo, git push among them — the moment a user sets one rule of
 * their own. The sentinel is what makes extending the defaults a choice rather
 * than an accident.
 */

export const AUTO_MODE_DEFAULTS_SENTINEL = '$defaults'

/**
 * Render one prompt section from the user's entries and the template's defaults.
 *
 * `defaultBlock` is the raw text captured from between the section's tags — it
 * is spliced verbatim rather than re-serialized, so the shipped wording is
 * preserved exactly.
 */
export function spliceAutoModeDefaults(
  userEntries: readonly string[] | undefined,
  defaultBlock: string,
): string {
  if (!userEntries || userEntries.length === 0) return defaultBlock

  const rendered: string[] = []
  let splicedDefaults = false
  for (const entry of userEntries) {
    if (entry === AUTO_MODE_DEFAULTS_SENTINEL) {
      // Only the first sentinel expands; upstream drops the rest silently.
      if (!splicedDefaults && defaultBlock.length > 0) {
        rendered.push(defaultBlock)
        splicedDefaults = true
      }
      continue
    }
    rendered.push(`- ${entry}`)
  }
  return rendered.join('\n')
}

/**
 * True when a user configured this section but did not ask for the defaults
 * back, i.e. they are about to be dropped.
 *
 * Fork-only guard. Upstream can absorb a config that silently discards the
 * shipped rules because it ships to many users behind review; here one operator
 * edits settings with no review gate, so a single omitted sentinel is one typo
 * away from disarming every deny rule. Callers warn; they do not override the
 * user's choice.
 */
export function autoModeSectionDropsDefaults(
  userEntries: readonly string[] | undefined,
): boolean {
  if (!userEntries || userEntries.length === 0) return false
  return !userEntries.includes(AUTO_MODE_DEFAULTS_SENTINEL)
}

/**
 * List form of the same rule, for callers that report the effective config
 * rather than assemble prompt text — `claude auto-mode config`, chiefly.
 *
 * It exists so the reporting surface and the prompt cannot disagree about what
 * the operator's settings actually do. A CLI that prints REPLACE semantics
 * while the classifier splices is worse than no CLI.
 */
export function spliceAutoModeDefaultsList(
  userEntries: readonly string[] | undefined,
  defaults: readonly string[],
): string[] {
  if (!userEntries || userEntries.length === 0) return [...defaults]
  const out: string[] = []
  let splicedDefaults = false
  for (const entry of userEntries) {
    if (entry === AUTO_MODE_DEFAULTS_SENTINEL) {
      if (!splicedDefaults) {
        out.push(...defaults)
        splicedDefaults = true
      }
      continue
    }
    out.push(entry)
  }
  return out
}

export type AutoModeSectionConfig = {
  allow?: string[]
  soft_deny?: string[]
  hard_deny?: string[]
  environment?: string[]
}

/**
 * Assemble the ported upstream system prompt from its two vendored modules.
 *
 * Pure by design: the caller supplies the template text. Feature gates compile
 * to `false` under `bun test`, so a version that read the gated module-level
 * constants directly could not be exercised by any test — and the one behaviour
 * that must never regress here (shipped deny rules surviving a user config) is
 * silent when it breaks.
 */
export function assembleUpstreamSystemPrompt(
  basePrompt: string,
  permissionsTemplate: string,
  config: AutoModeSectionConfig | undefined,
): string {
  // <cross_session_messages_rule> ships empty upstream: both of its call sites
  // substitute an empty string. <cc_automode_session_rules> is a wrapper around
  // ordinary prose rather than a slot, so it is left in place.
  const assembled = basePrompt
    .replace(
      '<permissions_template>',
      () =>
        `<cc_automode_permissions>\n${permissionsTemplate}\n</cc_automode_permissions>`,
    )
    .replace('<cross_session_messages_rule>', () => '')

  const section = (
    tag: string,
    entries: readonly string[] | undefined,
  ): ((source: string) => string) => {
    const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
    return source =>
      source.replace(pattern, (_m, defaults: string) =>
        spliceAutoModeDefaults(entries, defaults),
      )
  }

  return [
    section('user_allow_rules_to_replace', config?.allow),
    section('user_soft_deny_rules_to_replace', config?.soft_deny),
    section('user_hard_deny_rules_to_replace', config?.hard_deny),
    section('user_environment_to_replace', config?.environment),
  ].reduce((text, apply) => apply(text), assembled)
}
