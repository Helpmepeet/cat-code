import { RuntimeRequestError, type JsonValue } from './runtime/protocol.js'

const contextHelp = 'Put each sh value outside quotes as a separate argument after a literal command name. Keep the value out of assignments, redirections, comments, substitutions, and heredocs.'
const valueHelp = 'Pass a string, a finite number, or a nonempty array of those values to sh.'
// These words can change where the shell expects a command or other syntax.
// Ordinary executables and builtins may interpret their arguments independently.
const commandSyntax = new Set([
  'always', 'builtin', 'case', 'command', 'coproc', 'do', 'done', 'elif', 'else',
  'end', 'esac', 'exec', 'fi', 'for', 'foreach', 'function', 'if', 'in', 'nocorrect',
  'noglob', 'repeat', 'select', 'then', 'time', 'until', 'while',
])

function rawLiteral(text: string): string {
  return text.replace(/(\\+)(`|\$\{)/g, (match, slashes: string, suffix: string) =>
    slashes.length % 2 ? slashes.slice(0, -1) + suffix : match)
}

/** Prove argument boundaries in the shared shell grammar. The ordinary Bash
 * permission pipeline still decides what the assembled command may do. */
export function buildCodeModeShellCommand(request: Record<string, JsonValue>): string {
  const { literals, values } = request
  if (!Array.isArray(literals) || !literals.every(part => typeof part === 'string') ||
      !Array.isArray(values) || literals.length !== values.length + 1) {
    throw new RuntimeRequestError(`Use sh as a tagged template. ${valueHelp}`)
  }
  const parts = literals.map(rawLiteral)
  if (parts.some(part => part.includes('\0'))) throw new RuntimeRequestError('Remove NUL characters from the sh command.')
  if (!values.length) return parts[0]!

  let quote = ''
  let word = ''
  let commandSeen = false
  let optionsEnded = false
  let redirect = false
  let comment = false
  let result = ''
  function finishWord() {
    if (!word) return
    if (redirect) redirect = false
    else if (!commandSeen && !/^[A-Za-z_]\w*\+?=/.test(word)) {
      if (!/^[A-Za-z_./][A-Za-z0-9_./-]*$/.test(word) || commandSyntax.has(word)) {
        throw new RuntimeRequestError(contextHelp)
      }
      commandSeen = true
    } else if (commandSeen && word === '--') optionsEnded = true
    word = ''
  }

  function endCommand() {
    finishWord()
    if (redirect) throw new RuntimeRequestError(contextHelp)
    commandSeen = false
    optionsEnded = false
  }

  for (const [index, part] of parts.entries()) {
    for (let offset = 0; offset < part.length; offset++) {
      const char = part[offset]!
      const next = part[offset + 1]
      if (comment && char !== '\n') continue
      if (comment) comment = false
      if (char === '\\' && quote !== "'") {
        const escaped = part[++offset]
        if (!escaped || escaped === '\r') throw new RuntimeRequestError(contextHelp)
        if (escaped !== '\n') word += char + escaped
      } else if (quote) {
        if (char === quote) quote = ''
        else if (quote === '"' && (char === '$' || char === '`' || char === '!')) throw new RuntimeRequestError(contextHelp)
        word += char
      } else if (char === '"' || char === "'") {
        quote = char
        word += char
      } else if (char === ' ' || char === '\t') {
        finishWord()
      } else if (char === '#' && !word) {
        comment = true
      } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
        if (char === '<' && next === '<') throw new RuntimeRequestError(contextHelp)
        if (redirect && !word) throw new RuntimeRequestError(contextHelp)
        // Digits immediately before the operator are a file descriptor.
        if (!redirect && /^\d+$/.test(word)) word = ''
        finishWord()
        redirect = true
        if (next && (next === '&' || (char === '<' && next === '>') || (char !== '<' && next === '>') || (char === '>' && next === '|'))) offset++
      } else if (char === '\n' || char === ';' || char === '|' || char === '&') {
        if ((char === ';' && (next === ';' || next === '&')) || (char === '|' && next === '&') ||
            (char === '&' && (next === '!' || next === '|'))) throw new RuntimeRequestError(contextHelp)
        if ((char === '|' || char === '&') && next === char) offset++
        endCommand()
      } else {
        if (!/[A-Za-z0-9_./%:@+,=*?~\-]/.test(char)) throw new RuntimeRequestError(contextHelp)
        word += char
      }
    }
    result += part
    if (index === values.length) break
    const nextPart = parts[index + 1]!
    if (quote || word || comment || redirect || !commandSeen || (!nextPart && index + 1 < values.length) ||
        (nextPart && !/^[ \t\n;|&<>]/.test(nextPart))) throw new RuntimeRequestError(contextHelp)
    const value = values[index]
    const args = Array.isArray(value) ? value : [value]
    if (!args.length) throw new RuntimeRequestError(`The sh argument array is empty. Handle the empty case before running the command. ${valueHelp}`)
    result += args.map(item => {
      if (typeof item !== 'string' && (typeof item !== 'number' || !Number.isFinite(item))) throw new RuntimeRequestError(valueHelp)
      const argument = String(item)
      if (argument.includes('\0')) throw new RuntimeRequestError('Remove NUL characters from the sh argument.')
      if (!optionsEnded && argument.startsWith('-')) {
        throw new RuntimeRequestError('Place a standalone -- before sh arguments starting with -, or use a path starting with ./ where applicable.')
      }
      return `'${argument.replaceAll("'", "'\\''")}'`
    }).join(' ')
  }
  if (quote) throw new RuntimeRequestError(contextHelp)
  finishWord()
  if (redirect) throw new RuntimeRequestError(contextHelp)
  return result
}
