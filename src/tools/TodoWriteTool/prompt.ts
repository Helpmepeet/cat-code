import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { getAPIProvider, type APIProvider } from '../../utils/model/providers.js'

function getTodoWriteDefaultPrompt(): string {
  return `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress and organize complex tasks.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use a task list when the user requests one, or when tracking several outcomes or dependencies will help prevent omissions. Step count and tool-call count alone do not require a list. Skip it for straightforward work or an informational conversation.

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - At most one task is in_progress at a time, and none once every task is complete
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

`
}

function getTodoWriteGptPrompt(): string {
  return `Use this tool to create and manage a structured task list for the current coding session.

WHEN TO USE:
Use a task list when the user requests one, or when tracking several outcomes or dependencies will help prevent omissions. Step count and tool-call count alone do not require a list. Skip it for straightforward work or an informational conversation.

TASK STATE CONTRACT:
- Valid states are \`pending\`, \`in_progress\`, and \`completed\`.
- At most one task is \`in_progress\` at a time, and none once every task is complete.
- Mark a task \`in_progress\` BEFORE beginning it.
- Mark a task \`completed\` IMMEDIATELY after finishing it. Do not batch completions.
- Complete the current task before starting a new one when possible.
- Remove tasks that are no longer relevant.

TASK CONTENT CONTRACT:
- Every task must provide both forms:
  - \`content\`: imperative form, such as "Run tests"
  - \`activeForm\`: present continuous form, such as "Running tests"
- Create specific, actionable task names.
- Break complex work into smaller, manageable steps.

COMPLETION RULES:
- Mark a task \`completed\` ONLY when it is fully accomplished.
- If you are blocked or the work is incomplete, keep the task \`in_progress\`.
- If blocked, add a new task describing what must be resolved.
- Never mark a task \`completed\` if tests are failing, the implementation is partial, there are unresolved errors, or required files/dependencies are missing.`
}

export function getPrompt(provider: APIProvider = getAPIProvider()): string {
  return isGPTPromptStyle(provider)
    ? getTodoWriteGptPrompt()
    : getTodoWriteDefaultPrompt()
}

export const DESCRIPTION =
  'Update the todo list for the current session. Use when requested or when tracking outcomes and dependencies helps. Always provide both content (imperative) and activeForm (present continuous) for each task.'
