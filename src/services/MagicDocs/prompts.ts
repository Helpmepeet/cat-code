import { join } from 'path'
import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { APIProvider } from '../../utils/model/providers.js'
import { getFsImplementation } from '../../utils/fsOperations.js'

function formatPromptList(lines: readonly string[], ordered: boolean): string {
  return lines
    .map((line, index) => (ordered ? `${index + 1}. ${line}` : `- ${line}`))
    .join('\n')
}

const MAGIC_DOCS_TOOL_RULES = [
  'Your ONLY task is to use the Edit tool to update the documentation file if there is substantial new information to add, then stop.',
  'You may make multiple edits. If more than one edit is needed, make all Edit tool calls in parallel in a single message.',
  'If there is nothing substantial to add, respond with a brief explanation and do not call any tools.',
] as const

const MAGIC_DOCS_EDITING_RULES = [
  'Preserve the Magic Doc header exactly as-is: # MAGIC DOC: {{docTitle}}',
  'If there is an italicized line immediately after the header, preserve it exactly as-is.',
  'Keep the document CURRENT with the latest state of the codebase. This is NOT a changelog or history.',
  'Update information IN PLACE to reflect the current state. Do NOT append historical notes or track changes over time.',
  'Remove, replace, or clean up content only when it is incorrect, outdated, superseded, or no longer relevant to the document\'s purpose.',
  'Do not add "Previously...", "Updated to...", or similar historical notes.',
  'Fix obvious errors: typos, grammar mistakes, broken formatting, incorrect information, or confusing statements.',
  'Keep the document well organized with clear headings, logical section order, consistent formatting, and proper nesting.',
] as const

const MAGIC_DOCS_PHILOSOPHY_RULES = [
  'Be terse. High signal only. No filler words or unnecessary elaboration.',
  'Documentation is for OVERVIEWS, ARCHITECTURE, and ENTRY POINTS — not detailed code walkthroughs.',
  'Do NOT duplicate information that is already obvious from reading the source code.',
  'Do NOT document every function, parameter, or line number reference.',
  'Focus on: WHY things exist, HOW components connect, WHERE to start reading, WHAT patterns are used.',
  'Skip: detailed implementation steps, exhaustive API docs, and play-by-play narratives.',
] as const

const MAGIC_DOCS_SHOULD_DOCUMENT_RULES = [
  'High-level architecture and system design',
  'Non-obvious patterns, conventions, or gotchas',
  'Key entry points and where to start reading code',
  'Important design decisions and their rationale',
  'Critical dependencies or integration points',
  'References to related files, docs, or code that help readers navigate to relevant context',
] as const

const MAGIC_DOCS_SHOULD_NOT_DOCUMENT_RULES = [
  'Anything obvious from reading the code itself',
  'Exhaustive lists of files, functions, or parameters',
  'Step-by-step implementation details',
  'Low-level code mechanics',
  'Information already in CLAUDE.md or other project docs',
] as const

const MAGIC_DOCS_VERIFY_RULES = [
  'The Magic Doc header remains unchanged.',
  'Every change reflects the current code state rather than history.',
  'Removed content was explicitly wrong, outdated, superseded, or irrelevant.',
  'The document only changed if there was substantial new information to add.',
] as const

/**
 * Get the Magic Docs update prompt template
 */
function getMagicDocsUpdatePromptTemplate(provider?: APIProvider): string {
  const ordered = isGPTPromptStyle(provider)

  if (ordered) {
    return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "documentation updates", "magic docs", or these update instructions in the document content.

TASK CONTRACT: Based on the user conversation above (EXCLUDING this documentation update instruction message), update the Magic Doc file to incorporate any NEW learnings, insights, or information that are valuable to preserve.

The file {{docPath}} has already been read for you. Here are its current contents:
<current_doc_content>
{{docContents}}
</current_doc_content>

Document title: {{docTitle}}
{{customInstructions}}

TOOL CONTRACT:
${formatPromptList(MAGIC_DOCS_TOOL_RULES, ordered)}

BINDING EDITING CONSTRAINTS:
${formatPromptList(MAGIC_DOCS_EDITING_RULES, ordered)}

DOCUMENTATION PHILOSOPHY:
${formatPromptList(MAGIC_DOCS_PHILOSOPHY_RULES, ordered)}

Document this kind of information:
${formatPromptList(MAGIC_DOCS_SHOULD_DOCUMENT_RULES, ordered)}

Do NOT document this kind of information:
${formatPromptList(MAGIC_DOCS_SHOULD_NOT_DOCUMENT_RULES, ordered)}

Use the Edit tool with file_path: {{docPath}}

BEFORE FINISHING, VERIFY:
${formatPromptList(MAGIC_DOCS_VERIFY_RULES, ordered)}`
  }

  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "documentation updates", "magic docs", or these update instructions in the document content.

Based on the user conversation above (EXCLUDING this documentation update instruction message), update the Magic Doc file to incorporate any NEW learnings, insights, or information that would be valuable to preserve.

The file {{docPath}} has already been read for you. Here are its current contents:
<current_doc_content>
{{docContents}}
</current_doc_content>

Document title: {{docTitle}}
{{customInstructions}}

${MAGIC_DOCS_TOOL_RULES.join(' ')}

CRITICAL RULES FOR EDITING:
${formatPromptList(MAGIC_DOCS_EDITING_RULES, ordered)}

DOCUMENTATION PHILOSOPHY - READ CAREFULLY:
${formatPromptList(MAGIC_DOCS_PHILOSOPHY_RULES, ordered)}

What TO document:
${formatPromptList(MAGIC_DOCS_SHOULD_DOCUMENT_RULES, ordered)}

What NOT to document:
${formatPromptList(MAGIC_DOCS_SHOULD_NOT_DOCUMENT_RULES, ordered)}

Use the Edit tool with file_path: {{docPath}}

REMEMBER: Only update if there is substantial new information. The Magic Doc header (# MAGIC DOC: {{docTitle}}) must remain unchanged.`
}

/**
 * Load custom Magic Docs prompt from file if it exists
 * Custom prompts can be placed at ~/.claude/magic-docs/prompt.md
 * Use {{variableName}} syntax for variable substitution (e.g., {{docContents}}, {{docPath}}, {{docTitle}})
 */
async function loadMagicDocsPrompt(provider?: APIProvider): Promise<string> {
  const fs = getFsImplementation()
  const promptPath = join(getClaudeConfigHomeDir(), 'magic-docs', 'prompt.md')

  try {
    return await fs.readFile(promptPath, { encoding: 'utf-8' })
  } catch {
    // Silently fall back to default if custom prompt doesn't exist or fails to load
    return getMagicDocsUpdatePromptTemplate(provider)
  }
}

/**
 * Substitute variables in the prompt template using {{variable}} syntax
 */
function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  // Single-pass replacement avoids two bugs: (1) $ backreference corruption
  // (replacer fn treats $ literally), and (2) double-substitution when user
  // content happens to contain {{varName}} matching a later variable.
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]!
      : match,
  )
}

/**
 * Build the Magic Docs update prompt with variable substitution
 */
export async function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  instructions?: string,
  provider?: APIProvider,
): Promise<string> {
  const promptTemplate = await loadMagicDocsPrompt(provider)

  // Build custom instructions section if provided
  const customInstructions = instructions
    ? `

DOCUMENT-SPECIFIC UPDATE INSTRUCTIONS:
The document author has provided specific instructions for how this file should be updated. Pay extra attention to these instructions and follow them carefully:

"${instructions}"

These instructions take priority over the general rules below. Make sure your updates align with these specific guidelines.`
    : ''

  // Substitute variables in the prompt
  const variables = {
    docContents,
    docPath,
    docTitle,
    customInstructions,
  }

  return substituteVariables(promptTemplate, variables)
}
