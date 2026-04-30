import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'

const BUILT_IN_AGENT_MODE_ROLE_FILES = {
  'agent-mode-coding-worker': 'implementor',
  'agent-mode-verifier': 'verifier',
} as const

function getBuiltInAgentModeRoleFileName(agentType: string): string | null {
  return BUILT_IN_AGENT_MODE_ROLE_FILES[
    agentType as keyof typeof BUILT_IN_AGENT_MODE_ROLE_FILES
  ] ?? null
}

async function readRoleFile(projectRoot: string, roleFileName: string): Promise<string | null> {
  try {
    const content = await readFile(
      join(projectRoot, '.cat-code', 'roles', `${roleFileName}.md`),
      'utf-8',
    )
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function listContextFiles(projectRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(projectRoot, '.cat-code', 'context'), {
      withFileTypes: true,
    })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => `.cat-code/context/${entry.name}`)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export async function getAgentModePromptInjections(
  agentType: string,
  projectRoot: string = getProjectRoot(),
): Promise<string[]> {
  const roleFileName = getBuiltInAgentModeRoleFileName(agentType)
  if (!roleFileName) {
    return []
  }

  const [roleFileContent, contextFiles] = await Promise.all([
    readRoleFile(projectRoot, roleFileName),
    listContextFiles(projectRoot),
  ])

  const injections: string[] = []

  if (roleFileContent) {
    injections.push(
      [
        'Repo-local role file injection:',
        `Path: .cat-code/roles/${roleFileName}.md`,
        '',
        roleFileContent,
      ].join('\n'),
    )
  }

  injections.push(
    contextFiles.length > 0
      ? [
          'Available repo-local context files:',
          'Read whichever of these files are relevant to the task. Their contents are not injected automatically.',
          ...contextFiles.map(file => `- ${file}`),
        ].join('\n')
      : [
          'Available repo-local context files:',
          'No .md context files are currently available under .cat-code/context/.',
        ].join('\n'),
  )

  return injections
}
