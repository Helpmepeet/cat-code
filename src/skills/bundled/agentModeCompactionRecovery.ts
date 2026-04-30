import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import skillMd from './agent-mode-compaction-recovery/SKILL.md'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(skillMd)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Recover Agent Mode sessions after worker failures or compaction using preserved state and filesystem reconciliation.'

const WHEN_TO_USE =
  typeof frontmatter.when_to_use === 'string'
    ? frontmatter.when_to_use
    : undefined

export function registerAgentModeCompactionRecoverySkill(): void {
  registerBundledSkill({
    name: 'agent-mode-compaction-recovery',
    description: DESCRIPTION,
    whenToUse: WHEN_TO_USE,
    userInvocable: false,
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      if (args) {
        parts.push(`## Context\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
