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
      const heredoc = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|([^\s;|&<>]+))/.exec(rest)
      const delimiter = heredoc?.[2] ?? heredoc?.[3] ?? heredoc?.[4]
      let end = rest.length
      if (delimiter && !delimiter.startsWith('<')) {
        let lineStart = rest.indexOf('\n') + 1
        while (lineStart > 0 && lineStart < rest.length) {
          const newline = rest.indexOf('\n', lineStart)
          const lineEnd = newline < 0 ? rest.length : newline
          const line = rest.slice(lineStart, lineEnd)
          if ((heredoc?.[1] ? line.replace(/^\t+/, '') : line) === delimiter) {
            end = lineEnd
            break
          }
          lineStart = newline < 0 ? 0 : newline + 1
        }
      }
      tokens.push({ kind: 'plain', text: rest.slice(0, end) })
      offset += end
      continue
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

export type ShellPromptLine = { prompt: boolean; tokens: ShellToken[] }

/** Prompts are display chrome, never part of copied or executed source. */
export function shellPromptLines(source: string, start = 0, end = source.length): ShellPromptLine[] {
  const lines: ShellPromptLine[] = [{ prompt: false, tokens: [] }]
  let continued = false
  let lineHasText = false
  for (const token of shellTokens(source)) {
    const parts = token.text.split('\n')
    for (let index = 0; index < parts.length; index++) {
      const line = lines[lines.length - 1]!
      const text = parts[index]!
      if (text) {
        if (!lineHasText && /\S/.test(text)) {
          line.prompt = !continued && index === 0 && (token.kind === 'command' || token.kind === 'string')
          lineHasText = true
        }
        line.tokens.push({ kind: token.kind, text })
      }
      if (index < parts.length - 1) {
        let last: ShellToken | undefined
        for (let index = line.tokens.length - 1; index >= 0; index--) {
          if (/\S/.test(line.tokens[index]!.text)) { last = line.tokens[index]; break }
        }
        const backslashes = last ? /\\+$/.exec(last.text)?.[0].length ?? 0 : 0
        continued = !!last && (backslashes % 2 === 1 || (last.kind === 'operator' && ['|', '||', '&&'].includes(last.text)))
        lines.push({ prompt: false, tokens: [] })
        lineHasText = false
      }
    }
  }
  let offset = 0
  return lines.flatMap(line => {
    const length = line.tokens.reduce((length, token) => length + token.text.length, 0)
    const lineStart = offset
    offset += length + 1
    if (lineStart > end || (lineStart === end && end < source.length) || lineStart + length < start) return []
    let tokenOffset = lineStart
    return [{
      prompt: line.prompt && lineStart >= start,
      tokens: line.tokens.flatMap(token => {
        const from = Math.max(0, start - tokenOffset)
        const to = Math.min(token.text.length, end - tokenOffset)
        tokenOffset += token.text.length
        return to > from ? [{ ...token, text: token.text.slice(from, to) }] : []
      }),
    }]
  })
}
