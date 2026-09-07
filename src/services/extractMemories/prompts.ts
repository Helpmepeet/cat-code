/**
 * Prompt templates for the background memory extraction agent.
 *
 * The extraction agent runs as a perfect fork of the main conversation — same
 * system prompt, same message prefix. The main agent's system prompt always
 * has full save instructions; when the main agent writes memories itself,
 * extractMemories.ts skips that turn (hasMemoryWritesSince). This prompt
 * fires only when the main agent didn't write, so the save-criteria here
 * overlap the system prompt's harmlessly.
 */

import { feature } from 'bun:bundle'
import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import type { APIProvider } from '../../utils/model/providers.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from '../../memdir/memoryTypes.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../../tools/FilePatchTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'

const GPT_INDIVIDUAL_TYPE_SELECTION_RULES: readonly string[] = [
  '## Type selection rules',
  '',
  '- Save as `user` when the information is about the user\'s role, goals, responsibilities, preferences, or knowledge.',
  '- Save as `feedback` when the user is telling you how to work with them or how to approach this project in future conversations.',
  '- Save as `project` when the information is about ongoing work, constraints, motivations, stakeholders, deadlines, or incidents that are not derivable from the code or git history.',
  '- Save as `reference` when the information points to an external system, dashboard, tracker, or document and explains what it is for.',
  '- Do NOT save derivable repo facts, git history, fix recipes, or ephemeral task state.',
  '',
]

const GPT_COMBINED_TYPE_AND_SCOPE_RULES: readonly string[] = [
  '## Type and scope selection rules',
  '',
  '- Save as `user` and always keep it private when the information is about the current user\'s role, goals, responsibilities, preferences, or knowledge.',
  '- Save as `feedback` and default to private. Use team scope only when the guidance is clearly a project-wide convention that every contributor should follow, not a personal style preference.',
  '- Save as `project` and strongly bias toward team scope when the information is shared project context, constraints, motivations, deadlines, or incidents that help multiple contributors.',
  '- Save as `reference` and usually make it team-scoped when the information points to an external system others working in this project should know about.',
  '- Never store sensitive data in shared team memories.',
  '- Do NOT save derivable repo facts, git history, fix recipes, or ephemeral task state.',
  '',
]

/**
 * Shared opener for both extract-prompt variants.
 */
function opener(
  newMessageCount: number,
  existingMemories: string,
  provider?: APIProvider,
): string {
  const manifest =
    existingMemories.length > 0
      ? `\n\n## Existing memory files\n\n${existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : ''

  if (isGPTPromptStyle(provider)) {
    return [
      `TASK CONTRACT: Act as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and update the persistent memory system using only information from those messages.`,
      '',
      'TOOL CONSTRAINTS:',
      `- Allowed tools: ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, read-only ${BASH_TOOL_NAME} (ls/find/cat/stat/wc/head/tail and similar), and ${FILE_PATCH_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} for paths inside the memory directory only.`,
      `- ${BASH_TOOL_NAME} rm is not permitted.`,
      `- All other tools — MCP, Agent, write-capable ${BASH_TOOL_NAME}, and similar — will be denied.`,
      '',
      'EXECUTION CONTRACT:',
      '1. Use at most 2 tool-using turns.',
      `2. Tool turn 1: issue every required ${FILE_READ_TOOL_NAME} call in parallel for the files you might update.`,
      `3. Tool turn 2: issue every required ${FILE_WRITE_TOOL_NAME} and ${FILE_PATCH_TOOL_NAME} call in parallel.`,
      '4. Do not interleave reads and writes across additional tool-using turns.',
      `5. ${FILE_PATCH_TOOL_NAME} requires a prior ${FILE_READ_TOOL_NAME} of the same file.`,
      '',
      'SOURCE-OF-TRUTH CONSTRAINTS:',
      `- You MUST only use content from the last ~${newMessageCount} messages to decide what to save, update, or remove.`,
      '- Do NOT investigate or verify that content further.',
      '- Do NOT grep source files.',
      '- Do NOT read code to confirm whether a pattern exists.',
      '- Do NOT run git commands.' + manifest,
    ].join('\n')
  }

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update your persistent memory systems.`,
    '',
    `Available tools: ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, read-only ${BASH_TOOL_NAME} (ls/find/cat/stat/wc/head/tail and similar), and ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} for paths inside the memory directory only. ${BASH_TOOL_NAME} rm is not permitted. All other tools — MCP, Agent, write-capable ${BASH_TOOL_NAME}, etc — will be denied.`,
    '',
    `You have a limited turn budget. ${FILE_EDIT_TOOL_NAME} requires a prior ${FILE_READ_TOOL_NAME} of the same file, so the efficient strategy is: turn 1 — issue all ${FILE_READ_TOOL_NAME} calls in parallel for every file you might update; turn 2 — issue all ${FILE_WRITE_TOOL_NAME}/${FILE_EDIT_TOOL_NAME} calls in parallel. Do not interleave reads and writes across multiple turns.`,
    '',
    `You MUST only use content from the last ~${newMessageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.` +
      manifest,
  ].join('\n')
}

function buildAutoOnlyHowToSave(
  skipIndex: boolean,
  provider?: APIProvider,
): string[] {
  if (isGPTPromptStyle(provider)) {
    if (skipIndex) {
      return [
        '## Save procedure',
        '',
        '1. Check the existing memory list first. Update an existing file instead of creating a duplicate when the topic already exists.',
        '2. Write each memory to its own file (for example, `user_role.md` or `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '3. Keep the memory organized by topic rather than chronology.',
        '4. Update or remove memories that turn out to be wrong or outdated.',
        '5. Before saving changed guidance, compare it with existing memories for conflicts. If it supersedes or narrows an earlier rule, update or remove the old rule in the same save so both cannot remain active; preserve any non-overlapping conditions. If an existing MEMORY.md hook points to a reconciled topic, update or remove that hook too; do not create new hooks in this mode.',
        '6. Before finishing, verify from the successful write/patch tool results that each intended memory file was updated.',
      ]
    }

    return [
      '## Save procedure',
      '',
      '1. Check the existing memory list first. Update an existing file instead of creating a duplicate when the topic already exists.',
      '2. Write each memory to its own file (for example, `user_role.md` or `feedback_testing.md`) using this frontmatter format:',
      '',
      ...MEMORY_FRONTMATTER_EXAMPLE,
      '',
      '3. Add or update the matching pointer in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line under ~150 characters: `- [Title](file.md) — one-line hook`. The hook itself must preserve the complete decision rule, including every trigger qualifier and the resulting guidance, instead of relying on the title, broadening, or shortening it.',
      '4. Never write memory content directly into `MEMORY.md`.',
      '5. Keep the index concise because lines after 200 are truncated in the system prompt.',
      '6. Keep the memory organized by topic rather than chronology.',
      '7. Update or remove memories that turn out to be wrong or outdated.',
      '8. Before saving changed guidance, compare it with existing memories for conflicts. If it supersedes or narrows an earlier rule, update or remove the old rule and its index hook in the same save so both cannot remain active; preserve any non-overlapping conditions.',
      '9. Before finishing, verify from the successful write/patch tool results that each intended memory file was updated and that the `MEMORY.md` index update was included.',
    ]
  }

  return skipIndex
    ? [
        '## How to save memories',
        '',
        'Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
        '- Before saving changed guidance, compare it with existing memories for conflicts. If it supersedes or narrows an earlier rule, update or remove the old rule in the same save so both cannot remain active; preserve any non-overlapping conditions. If an existing MEMORY.md hook points to a reconciled topic, update or remove that hook too; do not create new hooks in this mode.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. The hook itself must preserve the complete decision rule, including every trigger qualifier and the resulting guidance, instead of relying on the title, broadening, or shortening it. It has no frontmatter. Never write memory content directly into `MEMORY.md`.',
        '',
        '- `MEMORY.md` is always loaded into your system prompt — lines after 200 will be truncated, so keep the index concise',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
        '- Before saving changed guidance, compare it with existing memories for conflicts. If it supersedes or narrows an earlier rule, update or remove the old rule and its index hook in the same save so both cannot remain active; preserve any non-overlapping conditions.',
      ]
}

function buildCombinedHowToSave(
  skipIndex: boolean,
  provider?: APIProvider,
): string[] {
  if (isGPTPromptStyle(provider)) {
    if (skipIndex) {
      return [
        '## Save procedure',
        '',
        '1. Check the existing memory list first. Update an existing file instead of creating a duplicate when the topic already exists.',
        '2. Write each memory to its own file in the chosen directory (private or team, based on the type and scope rules) using this frontmatter format:',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '3. Keep the memory organized by topic rather than chronology.',
        '4. Update or remove memories that turn out to be wrong or outdated.',
        '5. Before saving changed guidance, compare it with existing private and team memories for conflicts. A private correction may record an explicit scoped override but must not modify team memory. Update or remove a team rule only when the new guidance is clearly team-wide. Reconcile authorized changes in the same save while preserving non-overlapping conditions. If an existing MEMORY.md hook points to a reconciled topic, update or remove that hook too; do not create new hooks in this mode.',
        '6. Before finishing, verify from the successful write/patch tool results that each intended memory file was updated in the correct directory.',
      ]
    }

    return [
      '## Save procedure',
      '',
      '1. Check the existing memory list first. Update an existing file instead of creating a duplicate when the topic already exists.',
      '2. Write each memory to its own file in the chosen directory (private or team, based on the type and scope rules) using this frontmatter format:',
      '',
      ...MEMORY_FRONTMATTER_EXAMPLE,
      '',
      "3. Add or update the matching pointer in the same directory's `MEMORY.md`. Each directory (private and team) has its own `MEMORY.md` index — each entry should be one line under ~150 characters: `- [Title](file.md) — one-line hook`. The hook itself must preserve the complete decision rule, including every trigger qualifier and the resulting guidance, instead of relying on the title, broadening, or shortening it.",
      '4. Never write memory content directly into a `MEMORY.md` file.',
      '5. Keep both indexes concise because lines after 200 are truncated in the system prompt.',
      '6. Keep the memory organized by topic rather than chronology.',
      '7. Update or remove memories that turn out to be wrong or outdated.',
      '8. Before saving changed guidance, compare it with existing private and team memories for conflicts. A private correction may record an explicit scoped override but must not modify team memory. Update or remove a team rule only when the new guidance is clearly team-wide. Reconcile authorized changes and their index hooks in the same save while preserving non-overlapping conditions.',
      '9. Before finishing, verify from the successful write/patch tool results that each intended memory file was updated in the correct directory and that the corresponding `MEMORY.md` update was included.',
    ]
  }

  return skipIndex
    ? [
        '## How to save memories',
        '',
        "Write each memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
        '- Before saving changed guidance, compare it with existing private and team memories for conflicts. A private correction may record an explicit scoped override but must not modify team memory. Update or remove a team rule only when the new guidance is clearly team-wide. Reconcile authorized changes in the same save while preserving non-overlapping conditions. If an existing MEMORY.md hook points to a reconciled topic, update or remove that hook too; do not create new hooks in this mode.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        "**Step 1** — write the memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        "**Step 2** — add a pointer to that file in the same directory's `MEMORY.md`. Each directory (private and team) has its own `MEMORY.md` index — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. The hook itself must preserve the complete decision rule, including every trigger qualifier and the resulting guidance, instead of relying on the title, broadening, or shortening it. They have no frontmatter. Never write memory content directly into a `MEMORY.md`.",
        '',
        '- Both `MEMORY.md` indexes are loaded into your system prompt — lines after 200 will be truncated, so keep them concise',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
        '- Before saving changed guidance, compare it with existing private and team memories for conflicts. A private correction may record an explicit scoped override but must not modify team memory. Update or remove a team rule only when the new guidance is clearly team-wide. Reconcile authorized changes and their index hooks in the same save while preserving non-overlapping conditions.',
      ]
}

/**
 * Build the extraction prompt for auto-only memory (no team memory).
 * Four-type taxonomy, no scope guidance (single directory).
 */
export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
  provider?: APIProvider,
): string {
  const howToSave = buildAutoOnlyHowToSave(skipIndex, provider)

  return [
    opener(newMessageCount, existingMemories, provider),
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...(isGPTPromptStyle(provider) ? GPT_INDIVIDUAL_TYPE_SELECTION_RULES : []),
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
  ].join('\n')
}

/**
 * Build the extraction prompt for combined auto + team memory.
 * Four-type taxonomy with per-type <scope> guidance (directory choice
 * is baked into each type block, no separate routing section needed).
 */
export function buildExtractCombinedPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
  provider?: APIProvider,
): string {
  if (!feature('TEAMMEM')) {
    return buildExtractAutoOnlyPrompt(
      newMessageCount,
      existingMemories,
      skipIndex,
      provider,
    )
  }

  const howToSave = buildCombinedHowToSave(skipIndex, provider)

  return [
    opener(newMessageCount, existingMemories, provider),
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...(isGPTPromptStyle(provider) ? GPT_COMBINED_TYPE_AND_SCOPE_RULES : []),
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.',
    '',
    ...howToSave,
  ].join('\n')
}
