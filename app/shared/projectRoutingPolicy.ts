import { basename } from 'node:path'
import type { ProjectRouteDecision } from './projectRouting.js'

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Only current, direct work requests authorize context changes. Quoted evidence
 * and conversation history cannot authorize a move. Unrecognized prose stays. */
export function decideProjectRoute(text: string, roots: string[], suppressed: string[]): ProjectRouteDecision {
  let fenced = false
  const prose = text.split('\n').filter(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return false }
    return !fenced && !/^\s*(>|\[|\d{4}-\d\d-|(?:error|warn|info|debug|trace)\b)/i.test(line)
  }).join('\n').replace(/"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)/g, '')
    .replace(/`([^`\n]*)`/g, (_match, code: string) =>
      roots.some(root => code === root || code === basename(root)) ? code : '')
  const requests = prose.split(/\n|[.!?]+(?=\s|$)/).filter(sentence =>
    /^\s*(?:(?:please|can you|could you|let's|I want you to|I'd like you to)\s+)?(?:work|continue|fix|implement|add|update|change|refactor|debug|repair|build|test|remove|edit)\b/i.test(sentence) &&
    !/\b(?:do not|don't|not in|without|instead|but|logs?|stack trace|output|quoted|reference|mentions?|example|about|discuss|compare|describe|explain)\b/i.test(sentence))
  const mentioned = [...new Set(roots)].filter(root => requests.some(sentence =>
    new RegExp(`(^|[^\\w/-])${escape(root)}(?=$|[\\s\x60,;:)])`).test(sentence) ||
    new RegExp(`(^|[^\\w/-])${escape(basename(root))}(?=$|[^\\w/-])`, 'i').test(sentence)))
  if (mentioned.length !== 1) return { kind: 'stay' }
  const cwd = mentioned[0]!
  const name = basename(cwd)
  const explicit = requests.some(sentence => new RegExp(
    `\\b(?:in|on|at)\\s+(?:the\\s+)?(?:project\\s+)?\x60?(?:${escape(cwd)}|${escape(name)})(?=$|[\\s\x60,;:)])`, 'i',
  ).test(sentence))
  if (!explicit && suppressed.includes(cwd)) return { kind: 'stay' }
  return { kind: explicit ? 'auto' : 'ask', cwd, name, explicit }
}
