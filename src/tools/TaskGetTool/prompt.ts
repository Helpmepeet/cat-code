export const DESCRIPTION = 'Get a task by ID from the task list'

export const PROMPT = `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Dependency IDs for this task, including prerequisites that have already completed

## Tips

- Before starting, check that every prerequisite is completed. TaskGet's blockedBy contains dependency IDs, including completed prerequisites; TaskList omits completed prerequisites from its blockedBy summary.
- Use TaskList to see all tasks in summary form.
`
