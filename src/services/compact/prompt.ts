import { feature } from 'bun:bundle'
import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import type { APIProvider } from '../../utils/model/providers.js'

type RunStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'cancelled'

type ApprovalStatus = 'pending' | 'approved' | 'required'

type HandoffBlock = {
  summary: string
  open_questions: string[]
  resume_hint: string
}

type VerificationSummary = {
  verdict: 'pass' | 'fail' | 'warn'
  evidence: string
  issues: string[]
  recommended_direction: 'fix' | 're-plan' | 'block' | null
}
import type { PartialCompactDirection } from '../../types/message.js'
import {
  formatAgentModeSessionState,
  type AgentModeSessionState,
} from '../../agent-mode/sessionState.js'

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

// Aggressive no-tools preamble. The cache-sharing fork path inherits the
// parent's full tool set (required for cache-key match), and on Sonnet 4.6+
// adaptive-thinking models the model sometimes attempts a tool call despite
// the weaker trailer instruction. With maxTurns: 1, a denied tool call means
// no text output → falls through to the streaming fallback (2.79% on 4.6 vs
// 0.01% on 4.5). Putting this FIRST and making it explicit about rejection
// consequences prevents the wasted turn.
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

// Two variants: BASE scopes to "the conversation", PARTIAL scopes to "the
// recent messages". The <analysis> block is a drafting scratchpad that
// formatCompactSummary() strips before the summary reaches context.
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const GPT_DETAILED_ANALYSIS_INSTRUCTION_BASE = `ANALYSIS PHASE:
- First, write a complete <analysis> block. Do NOT start <summary> until the analysis is complete.
- Work chronologically through each message and section of the conversation.
- For each portion, identify:
  - the user's explicit requests and intents
  - your approach to addressing the user's requests
  - key decisions, technical concepts, and code patterns
  - specific details such as file names, full code snippets, function signatures, and file edits
  - errors you ran into and how you fixed them
  - explicit user feedback, especially when the user told you to do something differently
- Before leaving <analysis>, verify that every required element has been covered thoroughly and accurately.`

const GPT_DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `ANALYSIS PHASE:
- First, write a complete <analysis> block. Do NOT start <summary> until the analysis is complete.
- Work chronologically through the recent messages only.
- For each portion, identify:
  - the user's explicit requests and intents
  - your approach to addressing the user's requests
  - key decisions, technical concepts, and code patterns
  - specific details such as file names, full code snippets, function signatures, and file edits
  - errors you ran into and how you fixed them
  - explicit user feedback, especially when the user told you to do something differently
- Before leaving <analysis>, verify that every required element from the recent messages has been covered thoroughly and accurately.`

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
`

const AGENT_MODE_COMPACT_APPENDIX = `

AGENT MODE CONTINUITY REQUIREMENTS:
- This conversation may be an Agent mode orchestrator session. In that case, preserve session-critical state exactly and explicitly.
- Treat conversation history as secondary to durable session state. Do NOT infer or rewrite the objective, last handoff summary, active workers, or pending approvals from chat history when explicit session-state facts are provided.
- Preserve these items in the summary when present: objective, last handoff summary, active workers, and pending approvals.
- Keep worker transcripts, long logs, and noisy tool output out of the summary unless they are necessary to explain the current decision state.
- Prefer compact decision state over raw transcript history. The resumed orchestrator should be able to recover from persisted session state first and conversation summary second.
`

const AGENT_MODE_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts.

In your analysis process:
1. Verify the authoritative session-critical state first: objective, last handoff summary, active workers, pending approvals, and any explicitly provided session-state facts.
2. Then identify only the continuity-relevant conversation details that still matter for the next orchestrator decision.
3. Exclude transcript-heavy detail that can be recovered from the codebase, git/worktree state, or persisted artifacts.
4. Double-check that your final summary stays compact, decision-focused, and does not override explicit session-state facts with transcript inference.`

const GPT_AGENT_MODE_ANALYSIS_INSTRUCTION_BASE = `ANALYSIS PHASE:
- First, verify the authoritative session-critical state: objective, last handoff summary, active workers, pending approvals, and any explicitly provided session-state facts.
- Then identify only the conversation details that still matter for the next orchestrator decision.
- Exclude transcript-heavy detail that can be recovered from the codebase, git/worktree state, or persisted artifacts.
- Before leaving <analysis>, verify that the final summary stays compact, decision-focused, and does not override explicit session-state facts with transcript inference.`

const AGENT_MODE_BASE_COMPACT_PROMPT = `Your task is to create a compact Agent mode continuity summary for an orchestrated coding run.

This is NOT a normal conversation summary. Preserve session-critical decision state first, and summarize conversation details only when they are still needed for the next orchestrator decision.

${AGENT_MODE_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Session State: Preserve the authoritative objective, last handoff summary, active workers, pending approvals, and any other explicitly provided session-state facts exactly.
2. What Changed Since The Last Clean Boundary: Summarize only the meaningful planning, research, implementation, or verification progress that affects continuation.
3. Relevant Code And Artifact State: Mention only files, diffs, commands, or artifacts that the orchestrator still needs in active context. If something can be recovered from the repo, git state, or a run artifact, prefer a short pointer over a long transcript dump.
4. User Messages And Decisions: List all non-tool user messages and any explicit user approvals, rejections, or scope decisions that still matter.
5. Pending Tasks / Immediate Next Action: State exactly what should happen next when the run resumes.

Critical rules:
- Durable session state is authoritative. When authoritative session-state facts are provided, copy them forward accurately and do not override them with transcript inference.
- Keep the summary compact and decision-focused. Do not preserve worker transcript noise, long logs, or recoverable code excerpts unless they are necessary for the next step.
- If a detail can be recovered from the codebase, git/worktree state, or a persisted file outside prompt context, do not spend summary budget on it.
- The resumed orchestrator must be able to recover from session state first and summary second.

Return format:
<analysis>
[Chronological analysis that verifies the session-critical state and captures only continuity-relevant details]
</analysis>

<summary>
1. Session State:
   [Authoritative session state]

2. What Changed Since The Last Clean Boundary:
   [Meaningful progress only]

3. Relevant Code And Artifact State:
   [Only what still needs to stay in active context]

4. User Messages And Decisions:
   - [Non-tool user message or decision]

5. Pending Tasks / Immediate Next Action:
   [Exact next step]
</summary>`

const GPT_AGENT_MODE_BASE_COMPACT_PROMPT = `TASK CONTRACT: Create a compact Agent mode continuity summary for an orchestrated coding run.

This is NOT a normal conversation summary. Preserve session-critical decision state first. Summarize conversation details only when they are still needed for the next orchestrator decision.

OUTPUT CONTRACT:
- Return exactly two top-level blocks in this order: <analysis> then <summary>.
- Complete the entire <analysis> block before starting <summary>.
- Inside <summary>, return exactly 5 numbered sections in the order shown below.
- Every numbered section must be present and non-empty. If a section has no material content, write "None." and briefly say why.
- Keep the XML-style tags balanced and correctly nested.

${GPT_AGENT_MODE_ANALYSIS_INSTRUCTION_BASE}

Required <summary> sections in order:
1. Session State: Preserve the authoritative objective, last handoff summary, active workers, pending approvals, and any other explicitly provided session-state facts exactly.
2. What Changed Since The Last Clean Boundary: Summarize only the meaningful planning, research, implementation, or verification progress that affects continuation.
3. Relevant Code And Artifact State: Mention only files, diffs, commands, or artifacts that the orchestrator still needs in active context. If something can be recovered from the repo, git state, or a run artifact, prefer a short pointer over a long transcript dump.
4. User Messages And Decisions: List all non-tool user messages and any explicit user approvals, rejections, or scope decisions that still matter.
5. Pending Tasks / Immediate Next Action: State exactly what should happen next when the run resumes.

Critical rules:
- Durable session state is authoritative. When authoritative session-state facts are provided, copy them forward accurately and do not override them with transcript inference.
- Keep the summary compact and decision-focused. Do not preserve worker transcript noise, long logs, or recoverable code excerpts unless they are necessary for the next step.
- If a detail can be recovered from the codebase, git/worktree state, or a persisted file outside prompt context, do not spend summary budget on it.
- The resumed orchestrator must be able to recover from session state first and summary second.

Before finalizing, verify:
- section 1 preserves the provided session-critical state accurately
- the summary excludes worker transcript noise and recoverable details that do not need to stay in active context
- every non-tool user message that still matters appears in section 4
- section 5 gives an exact next action for immediate continuation

Return format:
<analysis>
[Chronological analysis that verifies session-critical state and continuity-relevant details]
</analysis>

<summary>
1. Session State:
   [Authoritative session state]

2. What Changed Since The Last Clean Boundary:
   [Meaningful progress only]

3. Relevant Code And Artifact State:
   [Only what still needs to stay in active context]

4. User Messages And Decisions:
   - [Non-tool user message or decision]

5. Pending Tasks / Immediate Next Action:
   [Exact next step]
</summary>`

const GPT_BASE_COMPACT_PROMPT = `TASK CONTRACT: Create a detailed summary of the conversation so far. Preserve enough technical detail, code patterns, and architectural decisions that development can continue without losing context.

OUTPUT CONTRACT:
- Return exactly two top-level blocks in this order: <analysis> then <summary>.
- Complete the entire <analysis> block before starting <summary>. Do not interleave them.
- Inside <summary>, return exactly 9 numbered sections in the order shown below.
- Every numbered section must be present and non-empty. If a section has no material content, write "None." and, when helpful, a short reason.
- Keep the XML-style tags balanced and correctly nested.

${GPT_DETAILED_ANALYSIS_INSTRUCTION_BASE}

Required <summary> sections in order:
1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate the specific files and code sections examined, modified, or created. Pay special attention to the most recent messages. Include full code snippets when they are important for continuity, and explain why each file read or edit matters.
4. Errors and fixes: List every material error encountered and how it was fixed. Pay special attention to explicit user feedback, especially when the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. This section is critical for preserving user feedback and intent changes.
7. Pending Tasks: Outline any pending tasks that you were explicitly asked to work on.
8. Current Work: Describe in detail what was being worked on immediately before this summary request, with special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step related to the most recent work. It must be DIRECTLY aligned with the user's most recent explicit requests and the task in progress immediately before compaction. Do not revive tangential or already completed requests without confirmation. If there is a valid next step, include direct verbatim quotes from the most recent conversation showing exactly what task was in progress and where it stopped. If there is no valid next step, write "None." and briefly say why.

Before finalizing, verify:
- every non-tool user message appears in section 6
- every important file read, file edit, or continuity-critical code snippet appears in section 3
- every material error, fix, and explicit user correction appears in section 4
- section 8 is detailed enough for someone to resume the work immediately
- section 9 stays directly aligned with the user's most recent explicit request

There may be additional summarization instructions in the included context. Follow them when producing the summary. Examples:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>

Return format:
<analysis>
[Chronological analysis that covers every required element before you write the summary]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Why this file matters]
      - [Changes or code snippets that matter for continuity]

4. Errors and fixes:
   - [Error description]
      - [How it was fixed]
      - [Relevant user feedback]

5. Problem Solving:
   [Description]

6. All user messages:
   - [Detailed non-tool user message]

7. Pending Tasks:
   - [Task]

8. Current Work:
   [Precise description of the immediate pre-compaction work state]

9. Optional Next Step:
   [Directly aligned next step, or "None."]
</summary>`

const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
`

const GPT_PARTIAL_COMPACT_PROMPT = `TASK CONTRACT: Create a detailed summary of only the RECENT portion of the conversation — the messages that come after earlier retained context. The earlier messages are being kept intact and must NOT be re-summarized.

OUTPUT CONTRACT:
- Return exactly two top-level blocks in this order: <analysis> then <summary>.
- Complete the entire <analysis> block before starting <summary>. Do not interleave them.
- Inside <summary>, return exactly 9 numbered sections in the order shown below.
- Every numbered section must be present and non-empty. If a section has no material content, write "None." and, when helpful, a short reason.
- Keep the XML-style tags balanced and correctly nested.

${GPT_DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Required <summary> sections in order:
1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages.
2. Key Technical Concepts: List the important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate the specific files and code sections examined, modified, or created in the recent messages. Include full code snippets when they are important for continuity, and explain why each file read or edit matters.
4. Errors and fixes: List the material errors encountered in the recent messages and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts in the recent messages.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct verbatim quotes from the most recent conversation when there is a valid next step. If there is no valid next step, write "None." and briefly say why.

Before finalizing, verify:
- the summary covers only the recent messages and does not re-summarize retained earlier context
- every non-tool user message from the recent portion appears in section 6
- every important recent file read, file edit, or continuity-critical code snippet appears in section 3
- every recent material error and fix appears in section 4
- section 8 is detailed enough to resume the current work immediately

Return format:
<analysis>
[Chronological analysis of the recent messages before you write the summary]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Why this file matters]
      - [Changes or code snippets that matter for continuity]

4. Errors and fixes:
   - [Error description]
      - [How it was fixed]

5. Problem Solving:
   [Description]

6. All user messages:
   - [Detailed non-tool user message]

7. Pending Tasks:
   - [Task]

8. Current Work:
   [Precise description of the immediate pre-compaction work state]

9. Optional Next Step:
   [Directly aligned next step, or "None."]
</summary>`

// 'up_to': model sees only the summarized prefix (cache hit). Summary will
// precede kept recent messages, hence "Context for Continuing Work" section.
const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents in detail
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks.
8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Work Completed:
   [Description of what was accomplished]

9. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]

</summary>
</example>

Please provide your summary following this structure, ensuring precision and thoroughness in your response.
`

const GPT_PARTIAL_COMPACT_UP_TO_PROMPT = `TASK CONTRACT: Create a detailed summary of this conversation prefix. Your summary will be placed at the start of a continuing session, and newer messages that build on this context will appear after it. Summarize thoroughly enough that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

OUTPUT CONTRACT:
- Return exactly two top-level blocks in this order: <analysis> then <summary>.
- Complete the entire <analysis> block before starting <summary>. Do not interleave them.
- Inside <summary>, return exactly 9 numbered sections in the order shown below.
- Every numbered section must be present and non-empty. If a section has no material content, write "None." and, when helpful, a short reason.
- Keep the XML-style tags balanced and correctly nested.

${GPT_DETAILED_ANALYSIS_INSTRUCTION_BASE}

Required <summary> sections in order:
1. Primary Request and Intent: Capture the user's explicit requests and intents in detail.
2. Key Technical Concepts: List the important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate the specific files and code sections examined, modified, or created. Include full code snippets when they are important for continuity, and explain why each file read or edit matters.
4. Errors and fixes: List the material errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks.
8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize the context, decisions, and state needed to understand and continue the work in the newer messages that follow.

Before finalizing, verify:
- every non-tool user message appears in section 6
- every important file read, file edit, or continuity-critical code snippet appears in section 3
- every material error and fix appears in section 4
- section 8 explains what was accomplished by the end of this portion
- section 9 gives enough context for someone to continue the work when newer messages follow after the summary

Return format:
<analysis>
[Chronological analysis of the conversation prefix before you write the summary]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Why this file matters]
      - [Changes or code snippets that matter for continuity]

4. Errors and fixes:
   - [Error description]
      - [How it was fixed]

5. Problem Solving:
   [Description]

6. All user messages:
   - [Detailed non-tool user message]

7. Pending Tasks:
   - [Task]

8. Work Completed:
   [Description of what was accomplished]

9. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]
</summary>`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
  provider?: APIProvider,
): string {
  const template = isGPTPromptStyle(provider)
    ? direction === 'up_to'
      ? GPT_PARTIAL_COMPACT_UP_TO_PROMPT
      : GPT_PARTIAL_COMPACT_PROMPT
    : direction === 'up_to'
      ? PARTIAL_COMPACT_UP_TO_PROMPT
      : PARTIAL_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

export function getCompactPrompt(
  customInstructions?: string,
  provider?: APIProvider,
  agentMode?: boolean,
): string {
  const template = agentMode
    ? isGPTPromptStyle(provider)
      ? GPT_AGENT_MODE_BASE_COMPACT_PROMPT
      : AGENT_MODE_BASE_COMPACT_PROMPT
    : isGPTPromptStyle(provider)
      ? GPT_BASE_COMPACT_PROMPT
      : BASE_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template

  if (!agentMode) {
    prompt += AGENT_MODE_COMPACT_APPENDIX
  }

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * Formats the compact summary by stripping the <analysis> drafting scratchpad
 * and replacing <summary> XML tags with readable section headers.
 * @param summary The raw summary string potentially containing <analysis> and <summary> XML tags
 * @returns The formatted summary with analysis stripped and summary tags replaced by headers
 */
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // Strip analysis section — it's a drafting scratchpad that improves summary
  // quality but has no informational value once the summary is written.
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // Extract and format summary section
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  // Clean up extra whitespace between sections
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')

  return formattedSummary.trim()
}

type AgentModeRunState = {
  objective: string
  planSummary: string | null
  currentPhase: RunStatus
  approvalStatus: ApprovalStatus
  approvalReason: string | null
  blockedReason: string | null
  executionTarget: string | null
  latestVerifierVerdict: VerificationSummary | null
  handoff: HandoffBlock | null
  nextAction: string
}

// A union, not one all-optional object, so that AgentModeSessionState is
// assignable to NEITHER member. AgentModeRunPhase and RunStatus are identical
// unions, so an all-optional shape would silently accept the narrow state and
// drop the worker roster — the defect this type is guarding against.
// `readSessionState()` is the only compaction-time source of Agent Mode state;
// route it through toAgentModeCompactState() rather than widening it by hand.
export type AgentModeCompactState =
  | (AgentModeRunState & { sessionState?: AgentModeSessionState | null })
  | { sessionState: AgentModeSessionState }

export function toAgentModeCompactState(
  sessionState: AgentModeSessionState | null | undefined,
): AgentModeCompactState | undefined {
  return sessionState ? { sessionState } : undefined
}

function formatAgentModeState(state: AgentModeCompactState): string {
  const lines: string[] = []

  // Only emit the run-state block when a caller supplied run fields. With just
  // a nested sessionState the block would restate objective/phase/next action
  // and print placeholders for the rest.
  if ('objective' in state) {
    const verifierVerdict = state.latestVerifierVerdict
      ? [
          `- Verdict: ${state.latestVerifierVerdict.verdict}`,
          `- Evidence: ${state.latestVerifierVerdict.evidence}`,
          `- Issues: ${
            state.latestVerifierVerdict.issues.length > 0
              ? state.latestVerifierVerdict.issues.join('; ')
              : 'none'
          }`,
          `- Recommended direction: ${
            state.latestVerifierVerdict.recommended_direction ?? 'none'
          }`,
        ].join('\n')
      : '- None recorded.'

    const handoff = state.handoff
      ? [
          `- Summary: ${state.handoff.summary}`,
          `- Open questions: ${
            state.handoff.open_questions.length > 0
              ? state.handoff.open_questions.join('; ')
              : 'none'
          }`,
          `- Resume hint: ${state.handoff.resume_hint}`,
        ].join('\n')
      : '- None recorded.'

    lines.push(
      'Agent Mode Run State (authoritative):',
      `- Objective: ${state.objective}`,
      `- Approved plan summary: ${state.planSummary ?? 'None recorded.'}`,
      `- Current phase: ${state.currentPhase}`,
      `- Approval status: ${state.approvalStatus}`,
      `- Approval reason: ${state.approvalReason ?? 'none'}`,
      `- Blocked reason: ${state.blockedReason ?? 'none'}`,
      `- Execution target: ${state.executionTarget ?? 'none recorded.'}`,
      'Latest verifier verdict:',
      verifierVerdict,
      'Handoff block:',
      handoff,
      `- Next action: ${state.nextAction}`,
    )
  }

  if (state.sessionState) {
    lines.push(formatAgentModeSessionState(state.sessionState))
  }

  return lines.join('\n')
}

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
  provider?: APIProvider,
  agentModeState?: AgentModeCompactState,
): string {
  const formattedSummary = formatCompactSummary(summary)
  const sessionStatePrefix = agentModeState
    ? `${formatAgentModeState(agentModeState)}\n\n`
    : ''

  let baseSummary = agentModeState
    ? isGPTPromptStyle(provider)
      ? `This session is continuing after context compaction. The structured Agent Mode run state below is authoritative; the summary below is preserved continuity context only.

${sessionStatePrefix}${formattedSummary}`
      : `This session is being continued from a previous conversation that ran out of context. The structured Agent Mode run state below is authoritative; the summary below is preserved continuity context only.

${sessionStatePrefix}${formattedSummary}`
    : isGPTPromptStyle(provider)
      ? `This session is continuing after context compaction. The summary below covers the earlier portion of the conversation and should be treated as preserved context for continuing the work.

${formattedSummary}`
      : `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\nRecent messages are preserved verbatim.`
  }

  if (suppressFollowUpQuestions) {
    let continuation = agentModeState
      ? isGPTPromptStyle(provider)
        ? `${baseSummary}
Resume directly from the last task. Do not acknowledge the summary, do not recap prior work, and do not ask the user to restate context. Continue as if the interruption never happened.`
        : `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`
      : isGPTPromptStyle(provider)
        ? `${baseSummary}
Continue as if the interruption never happened.`
        : `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions.`

    if (
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive()
    ) {
      continuation += isGPTPromptStyle(provider)
        ? `

You are running in autonomous/proactive mode. This is not a first wake-up. Continue the existing work loop immediately based on the summary above. Do not greet the user or ask what to work on.`
        : `

You are running in autonomous/proactive mode. This is NOT a first wake-up — you were already working autonomously before compaction. Continue your work loop: pick up where you left off based on the summary above. Do not greet the user or ask what to work on.`
    }

    return continuation
  }

  return baseSummary
}
