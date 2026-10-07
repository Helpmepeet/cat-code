import { isPlanModeInterviewPhaseEnabled } from '../../utils/planModeV2.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

const WHAT_HAPPENS_SECTION = `## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

`

// One variant for every user type. The former external-only text told the model
// to prefer plan mode for most implementation work and to "err on the side of
// planning", which contradicts the ACT OR ASK rule in the GPT system
// prompt (proceed when intent is clear and the step is reversible).
export function getEnterPlanModeToolPrompt(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `Use this tool when a task has genuine ambiguity about the right approach and getting user input before coding would prevent significant rework. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

Do not enter plan mode merely because a task is nontrivial or touches several files. If the intent is clear and the next steps are reversible, proceed. Research and explanation do not require plan mode or delegation. Use ${ASK_USER_QUESTION_TOOL_NAME} for a specific blocking choice when a full planning phase is unnecessary.

${whatHappens}Entering plan mode requires user approval.
`
}
