import { feature } from 'bun:bundle'
import type { Command } from '../commands.js'
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import { isEnvTruthy } from '../utils/envUtils.js'

const DEFAULT_INIT_PROMPT = `Create a concise CLAUDE.md at the repository root to guide future Cat Code sessions. First inspect the repository's README, manifests, build and CI configuration, relevant tests, and existing instruction files (including CLAUDE.md, AGENTS.md, Cursor rules, and Copilot instructions when present). Use source evidence rather than guessing conventions.

Include only what will help an agent work correctly here:
- The major source and test locations or architectural boundaries that are not obvious from a quick file listing.
- Commands for local development, build, lint, and tests, including how to run a focused test when that differs from the full suite.
- Project-specific style, naming, testing, and commit or pull request conventions when the repository provides evidence for them. Check recent Git history if you include commit conventions.
- Required setup and non-obvious workflow or security constraints.

Use descriptive headings and short, actionable explanations with examples where helpful. Adapt the sections to this repository. Keep the file as short as the useful facts allow; do not duplicate the README, inventory every file, invent requirements, or add generic coding advice. Do not include credentials.

If CLAUDE.md already exists, read it and suggest specific, evidence-backed improvements instead of replacing it. Summarize what you created or would change and note any important facts you could not verify.`

const INTERACTIVE_INIT_PROMPT = `Set up concise repository instructions for Cat Code. Instruction files load in every session, so keep only facts and constraints that improve future work.

Ask which instruction files the user wants: project CLAUDE.md, personal CLAUDE.local.md, or both. Ask whether they also want skills or hooks; create those only if the user chooses them. Do not turn declined artifacts into extra CLAUDE.md rules.

Inspect the README, manifests, build and CI configuration, relevant tests, existing CLAUDE.md and CLAUDE.local.md, AGENTS.md, and other agent instruction files when present. Find actual commands, architectural boundaries, style and naming rules, test conventions, setup needs, and workflow pitfalls. Check recent Git history only if commit conventions are worth documenting. Ask follow-up questions only for important facts the repository cannot establish.

For project CLAUDE.md, use short headings and actionable, evidence-backed guidance. Include non-obvious commands and constraints, focused test instructions, and relevant project structure or architecture. Adapt sections to the repository. Avoid generic advice, exhaustive file lists, copied README content, invented requirements, and credentials. For personal CLAUDE.local.md, include only the user's stated private preferences or local setup and add the file to .gitignore. If either file exists, preserve useful content, make focused improvements, and explain what changed.

If personal guidance is requested, run \`git worktree list\`. Nested worktrees can find the main checkout's CLAUDE.local.md through ancestor lookup; sibling or external worktrees cannot. If those exist, ask whether the guidance should apply across them. For shared guidance, keep the content in a home-directory file such as \`~/.cat-code/<project-name>-instructions.md\` and give each worktree a gitignored CLAUDE.local.md that imports it with \`@~/.cat-code/<project-name>-instructions.md\`. Keep personal imports out of project CLAUDE.md.

If the user requested skills, create only useful repeatable workflows or task-specific references in .cat-code/skills/<name>/SKILL.md. Check for existing skills before creating duplicates. If the user requested hooks, use the update-config skill's hooks guidance, choose an event and matcher supported by this Cat Code build, and validate the result. Ask before creating a hook whose trigger or effect is unclear. Do not add dependencies or external tools as part of /init unless the user separately requests them.

Finish with the files created or proposed changes, the key guidance captured, and any material uncertainty. Do not add a generic plugin or tooling recommendation list.`

const command = {
  type: 'prompt',
  name: 'init',
  get description() {
    return feature('NEW_INIT') &&
      (process.env.USER_TYPE === 'ant' ||
        isEnvTruthy(process.env.CLAUDE_CODE_NEW_INIT))
      ? 'Initialize new CLAUDE.md file(s) and optional skills/hooks with codebase documentation'
      : 'Initialize a new CLAUDE.md file with codebase documentation'
  },
  contentLength: 0, // Dynamic content
  progressMessage: 'analyzing your codebase',
  source: 'builtin',
  async getPromptForCommand() {
    maybeMarkProjectOnboardingComplete()

    return [
      {
        type: 'text',
        text:
          feature('NEW_INIT') &&
          (process.env.USER_TYPE === 'ant' ||
            isEnvTruthy(process.env.CLAUDE_CODE_NEW_INIT))
            ? INTERACTIVE_INIT_PROMPT
            : DEFAULT_INIT_PROMPT,
      },
    ]
  },
} satisfies Command

export default command
