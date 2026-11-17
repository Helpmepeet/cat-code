const PERMISSIONS_START = '<cc_automode_permissions>\n'
const PERMISSIONS_END = '\n</cc_automode_permissions>'
const INTENT_HEADING = '## User Intent Rule'
const EVALUATION_HEADING = '## Evaluation Rules'
const ALLOW_HEADING = '## ALLOW (exceptions) if ANY of these apply'

const BASE_HEADINGS = [
  '## Context',
  '## Threat Model',
  '## Input',
  '## Default Rule',
  '## Scope',
  INTENT_HEADING,
  EVALUATION_HEADING,
]
const PERMISSIONS_HEADINGS = [
  '## Environment',
  '## Definitions',
  '## HARD BLOCK — security boundaries (User Intent Rule does NOT clear these)',
  '## SOFT BLOCK — destructive or irreversible (User Intent Rule CAN clear these)',
  ALLOW_HEADING,
]

function hasHeadings(text: string, expected: readonly string[]): boolean {
  const headings = text.match(/^## .+$/gm) ?? []
  return headings.length === expected.length &&
    headings.every((heading, index) => heading === expected[index])
}

/**
 * Candidate for labeled evals only. Stage 1 ignores intent and exceptions, so
 * omit those two complete sections while preserving all harm rules verbatim.
 * The thinking stage still gets the complete policy. A changed template or
 * custom rule containing structural headings keeps the complete policy too.
 * Production callers must keep the full variant until paired evals pass.
 */
export function buildReducedAutoModeStagePolicy(
  fullSystemPrompt: string,
  stage: 'fast' | 'thinking',
): string {
  if (stage !== 'fast') return fullSystemPrompt
  const start = fullSystemPrompt.indexOf(PERMISSIONS_START)
  const end = fullSystemPrompt.indexOf(PERMISSIONS_END)
  if (start < 0 || end < start ||
    start !== fullSystemPrompt.lastIndexOf(PERMISSIONS_START) ||
    end !== fullSystemPrompt.lastIndexOf(PERMISSIONS_END)) return fullSystemPrompt

  const before = fullSystemPrompt.slice(0, start)
  const permissions = fullSystemPrompt.slice(start + PERMISSIONS_START.length, end)
  const after = fullSystemPrompt.slice(end + PERMISSIONS_END.length)
  // Do not infer section boundaries from user rule text. Unexpected, missing,
  // or duplicate headings make reduction inapplicable rather than losing rules.
  if (!hasHeadings(before, BASE_HEADINGS) ||
    !hasHeadings(permissions, PERMISSIONS_HEADINGS) ||
    !hasHeadings(after, ['## Classification Process', '## Output Format'])) return fullSystemPrompt

  const intent = before.indexOf(`${INTENT_HEADING}\n`)
  const evaluation = before.indexOf(`${EVALUATION_HEADING}\n`)
  const allow = permissions.indexOf(`${ALLOW_HEADING}\n`)
  if (intent < 0 || evaluation < intent || allow < 0) return fullSystemPrompt
  return before.slice(0, intent) + before.slice(evaluation) +
    PERMISSIONS_START + permissions.slice(0, allow) + PERMISSIONS_END + after
}
