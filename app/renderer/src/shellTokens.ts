export type ShellToken = { kind: 'command' | 'flag' | 'string' | 'operator' | 'comment' | 'plain'; text: string }

/** Display-only scanning; execution always uses the original fence text. */
export function shellTokens(source: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let offset = 0
  let command = true
  while (offset < source.length) {
    const rest = source.slice(offset)
    const whitespace = /^\s+/.exec(rest)?.[0]
    if (whitespace) {
      tokens.push({ kind: 'plain', text: whitespace })
      if (whitespace.includes('\n')) command = true
      offset += whitespace.length
      continue
    }
    if (rest.startsWith('<<')) {
      tokens.push({ kind: 'plain', text: rest })
      break
    }
    if (rest[0] === '#') {
      const end = rest.indexOf('\n')
      const text = end < 0 ? rest : rest.slice(0, end)
      tokens.push({ kind: 'comment', text })
      offset += text.length
      continue
    }
    const operator = /^(?:\|\||&&|[|;&()<>])/.exec(rest)?.[0]
    if (operator) {
      tokens.push({ kind: 'operator', text: operator })
      if (['|', '||', '&&', ';'].includes(operator)) command = true
      offset += operator.length
      continue
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0]
      let end = 1
      while (end < rest.length) {
        if (quote === '"' && rest[end] === '\\') { end += Math.min(2, rest.length - end); continue }
        if (rest[end++] === quote) break
      }
      tokens.push({ kind: 'string', text: rest.slice(0, end) })
      offset += end
      command = false
      continue
    }
    const text = /^(?:\\[\s\S]|[^\s|;&()<>"'])+/.exec(rest)?.[0] ?? rest[0]!
    tokens.push({ kind: command ? 'command' : text.startsWith('-') ? 'flag' : 'plain', text })
    command = false
    offset += text.length
  }
  return tokens
}
