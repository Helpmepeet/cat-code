import { CLAUDE_CLI_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'Delegate a bounded task to the external Claude Code CLI and return its result.'

export const PROMPT = `# ${CLAUDE_CLI_TOOL_NAME}

Use this tool to delegate a self-contained task to the external Claude Code CLI.

This tool runs the external \`claude\` executable in non-interactive print mode. It does not launch Cat Code, \`cat-code\`, \`./cli\`, or \`./cli-dev\`.
By default, the external Claude CLI inherits this process environment, including Claude auth variables, unless \`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB\` is set.

Use it when:
- You want a second Claude model pass on a bounded task, review, or investigation.
- The task can be expressed as one complete prompt.
- You want to choose Claude model or effort for that delegated run.

Input guidance:
- \`prompt\` must include all context the external Claude CLI needs. It will not see your current conversation unless you include the relevant details.
- Use \`model\` for Claude CLI model aliases or full model names such as \`sonnet\`, \`opus\`, or a full model ID.
- Use \`effort\` for Claude CLI effort levels: \`low\`, \`medium\`, \`high\`, \`xhigh\`, or \`max\`.
- Use \`cwd\` when the delegated task should run from a specific project directory.
- Use \`max_turns\` to bound the delegated agent loop.
- Use \`permission_mode\` only when the delegated run needs a specific Claude CLI permission mode: \`default\`, \`acceptEdits\`, \`plan\`, \`auto\`, \`dontAsk\`, or \`bypassPermissions\`.

The result includes status, exit code, stdout, stderr, parsed result text when Claude CLI returns JSON, and session metadata when available.`
