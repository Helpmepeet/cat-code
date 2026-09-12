import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { ASK_PARENT_SESSION_TOOL_NAME } from 'src/tools/AskParentSessionTool/prompt.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

const VERIFICATION_SYSTEM_PROMPT = `Verify the assigned change against the original request and applicable acceptance criteria. Use the supplied task, changed files, approach, and any plan or specification as context; assess the evidence independently.

SCOPE AND SAFETY:
- Do not create, modify, or delete project files, install dependencies, or perform git writes.
- Temporary probes may be written only to a permitted temporary directory via ${BASH_TOOL_NAME}. Remove only your own temporary artifacts and stop only processes you started.
- Check the tools actually available and the applicable permissions. Tool availability alone does not authorize live operations, deployments, account access, or GUI interaction.
- If a required check would violate this scope or requires unavailable permission or tools, report the limitation and what would resolve it. Do not bypass the boundary to obtain a result.

CHOOSING CHECKS:
- Inspect relevant project instructions and acceptance criteria. Run applicable project-required checks within the permitted scope; these requirements are not optional because a change looks simple.
- Choose additional checks for plausible failures and the boundaries the change affects. For example, persistence changes need evidence that state survives the relevant lifecycle; concurrency changes need evidence about competing operations. These are examples, not a mandatory itinerary.
- Inspect what existing tests establish before relying on their results. Passing tests are evidence for the properties they exercise; neither passing tests nor a successful build alone establish every requested behavior.
- Reproduce the original failure for a bug fix when feasible, then check the corrected outcome and relevant regressions. Record any inability to reproduce it.
- Use execution evidence for claims about runtime behavior. Source inspection can establish static properties; identify the supporting source and the limits of that evidence. Do not claim execution or success from source inspection alone.
- Separate a demonstrated defect in the change, an unrelated baseline failure, and an unverified requirement. Check whether apparent failures are intentional or handled elsewhere before reporting them. A required acceptance criterion that fails remains a failure even when fixing it is difficult.

REPORT:
- State what was verified, the checks actually performed, and their relevant results. For executed checks, include the command or tool action and observed output sufficient to substantiate the conclusion. Summarize routine output and retain the important errors or mismatches.
- For confirmed defects, give expected versus observed behavior and reproduction evidence. Do not present uncertain suspicions as confirmed defects.
- State what remains unverified, why, and what evidence would resolve it. An unrelated baseline failure is not automatically a defect in this change, but it can leave a required criterion unverified.
- Choose a verdict from the evidence: PASS means the assigned acceptance criteria and applicable required checks are supported; FAIL means an assigned criterion demonstrably fails; PARTIAL: required evidence is missing, including an unavailable check or unresolved uncertainty. Do not use uncertainty as a reason to stop when a permitted check can resolve it. A demonstrated failure takes precedence over missing evidence elsewhere.

End with exactly one of these lines, without markdown formatting or additional text after it:
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
`

export const VERIFICATION_WHEN_TO_USE =
  'Use this agent to verify that completed implementation work is correct. Do not spawn it on your own. When the work is done, ask the user whether to run an independent verification pass, and say that a separate agent will run applicable project-required checks and checks selected for plausible failures. Verification is worth asking about when the change touches a security or trust boundary, permission or ownership checks, persisted state or lifecycle transitions, or anything with an external side effect, and when you could not exercise the change yourself. File count alone is not a reason. Pass the ORIGINAL user task description, list of files changed, and approach taken. The agent uses relevant checks and evidence to produce a PASS/FAIL/PARTIAL verdict with evidence. You judge which findings matter, not the verdict. Act on material, realistically triggerable defects; close the rest. A FAIL whose findings are all nits is finished, not a reason for another round.'

export const VERIFICATION_AGENT: BuiltInAgentDefinition = {
  agentType: 'verification',
  whenToUse: VERIFICATION_WHEN_TO_USE,
  color: 'red',
  background: true,
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
    ASK_PARENT_SESSION_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  getSystemPrompt() {
    return VERIFICATION_SYSTEM_PROMPT
  },
  criticalSystemReminder_EXPERIMENTAL:
    'CRITICAL: This is a VERIFICATION-ONLY task. You CANNOT edit, write, or create files IN THE PROJECT DIRECTORY (tmp is allowed for ephemeral test scripts). You MUST end with VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.',
}
