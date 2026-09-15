import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { getAPIProvider, type APIProvider } from '../../utils/model/providers.js'

function getTodoWriteDefaultPrompt(): string {
  return `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress and organize complex tasks.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

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

When in doubt, use this tool.
`
}

function getTodoWriteGptPrompt(): string {
  return `Use this tool to create and manage a structured task list for the current coding session.

WHEN TO USE:
1. The task requires 3 or more distinct steps.
2. The task is non-trivial and needs planning or multiple operations.
3. The user explicitly asks for a todo list.
4. The user gives multiple requested tasks in one message.
5. You receive new instructions that should be captured as tracked work.
6. You begin work on a tracked task and need to mark it \`in_progress\`.
7. You finish a tracked task and need to mark it \`completed\` or add follow-up tasks.

WHEN NOT TO USE:
1. There is only one straightforward task.
2. The task is trivial and tracking it adds no value.
3. The work can be completed in fewer than 3 trivial steps.
4. The request is purely conversational or informational.

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
  'Update the todo list for the current session. To be used proactively and often to track progress and pending tasks. Always provide both content (imperative) and activeForm (present continuous) for each task.'
