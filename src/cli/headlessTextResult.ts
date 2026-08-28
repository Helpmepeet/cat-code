import type { SDKResultMessage } from '../entrypoints/sdk/coreTypes.generated.js'

/**
 * Render a headless run's final result for `--output-format text`.
 *
 * Extracted from `runHeadless` so every result subtype has a directly
 * assertable output. The switch previously lived inline and covered only the
 * five subtypes upstream emits; `interrupted` and `error_auth_required` were
 * added to the union by 0da3dac4 without extending it, so both produced no
 * output at all.
 */
export function formatHeadlessTextResult(
  result: SDKResultMessage,
  limits: { maxTurns?: number; maxBudgetUsd?: number },
): string {
  switch (result.subtype) {
    case 'success':
      return result.result?.endsWith('\n')
        ? result.result
        : `${result.result ?? ''}\n`
    case 'error_during_execution':
      return `Execution error`
    case 'error_max_turns':
      return `Error: Reached max turns (${limits.maxTurns})`
    case 'error_max_budget_usd':
      return `Error: Exceeded USD budget (${limits.maxBudgetUsd})`
    case 'error_max_structured_output_retries':
      return `Error: Failed to provide valid structured output after maximum retries`
    case 'interrupted':
      return `Interrupted\n`
    case 'error_auth_required':
      return `Error: Authentication required\n`
    default: {
      // Exhaustiveness tripwire. Verified to fire under this repo's
      // `strict: false`: removing any case above makes tsc reject the
      // assignment. Never replace this with a silent fallthrough — silent
      // output is the defect it exists to prevent.
      const unhandledSubtype: never = result.subtype
      void unhandledSubtype
      return ''
    }
  }
}
