import { resolve } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { asSystemPrompt, type SystemPrompt } from '../utils/systemPromptType.js'

// Remove this module and its query.ts call site after the experiment expires.
export const HARNESS_FEEDBACK_EXPIRES_AT = Date.parse('2026-11-03T00:00:00+07:00')

export function withTemporaryHarnessFeedback(
  systemPrompt: SystemPrompt,
  now = Date.now(),
): SystemPrompt {
  if (now >= HARNESS_FEEDBACK_EXPIRES_AT) return systemPrompt

  const feedbackPath = resolve(getClaudeConfigHomeDir(), 'harness-feedback.md')
  return asSystemPrompt([
    ...systemPrompt,
    `# Temporary harness feedback

Only before November 3, 2026 (Asia/Bangkok): when you encounter a concrete suspected Cat Code harness problem during your work, append a short Markdown entry to ${JSON.stringify(feedbackPath)}, even if a workaround succeeds. Include the date, session/agent ID when available, expected versus observed behavior, relevant error or tool-call ID, and workaround/impact. Distinguish observation from suspected cause; do not investigate beyond the assigned task.

Use a single append-only write, never rewrite existing reports. Follow normal permissions and role restrictions. If you cannot write, include the feedback in your report to the parent agent or user; parent agents record feedback returned by workers. Do not include credentials, full transcripts, or ordinary project failures and correctly enforced permission denials. Reporting does not replace disclosing blockers or uncertain results.`,
  ])
}
