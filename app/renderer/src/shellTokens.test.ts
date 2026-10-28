import { expect, test } from 'bun:test'
import { shellPromptLines, shellTokens } from './shellTokens.js'

for (const source of ['ps aux | head -n 20', 'pwd && git status --short', 'echo "a | b" || echo \'c && d\'', 'ls -l; pwd # comment\nwhoami', 'cat <<EOF\n$plain | text\nEOF', 'echo "unfinished', "echo 'unfinished", 'echo escaped\\ pipe']) {
  test(`shell coloring preserves source: ${JSON.stringify(source)}`, () => {
    expect(shellTokens(source).map(token => token.text).join('')).toBe(source)
  })
}
test('commands and flags restart after pipes and conditionals', () => {
  const tokens = shellTokens('ps aux | head -n 20 && git status --short; pwd')
  expect(tokens.filter(token => token.kind === 'command').map(token => token.text)).toEqual(['ps', 'head', 'git', 'pwd'])
  expect(tokens.filter(token => token.kind === 'flag').map(token => token.text)).toEqual(['-n', '--short'])
})
test('quoted operators remain strings and comments stop at newline', () => {
  const tokens = shellTokens('echo "a | b" # comment\npwd')
  expect(tokens.filter(token => token.kind === 'operator')).toEqual([])
  expect(tokens.find(token => token.kind === 'string')?.text).toBe('"a | b"')
  expect(tokens.find(token => token.kind === 'comment')?.text).toBe('# comment')
  expect(tokens.at(-1)).toEqual({ kind: 'command', text: 'pwd' })
})
test('heredoc remainder stays plain', () => {
  expect(shellTokens('cat <<EOF\necho | $value\nEOF').at(-1)).toEqual({ kind: 'plain', text: '<<EOF\necho | $value\nEOF' })
})

for (const [source, prompts] of [
  ['echo hi\npwd', [true, true]],
  ['echo hello \\\n  world\npwd', [true, false, true]],
  ['printf hi |\n  cat\npwd', [true, false, true]],
  ['cat <<EOF\necho not-a-command\nEOF\npwd', [true, false, false, true]],
  ["cat <<-'EOF'\n\techo not-a-command\n\tEOF\npwd", [true, false, false, true]],
  ['echo "one\ntwo"\npwd', [true, false, true]],
  ['# comment\n\npwd', [false, false, true]],
] as const) {
  test(`prompt marks preserve source and skip continuations: ${JSON.stringify(source)}`, () => {
    const lines = shellPromptLines(source)
    expect(lines.map(line => line.prompt)).toEqual([...prompts])
    expect(lines.map(line => line.tokens.map(token => token.text).join('')).join('\n')).toBe(source)
  })
}

test('windowed prompt lines retain full-source heredoc and continuation context', () => {
  const source = 'cat <<EOF\necho body\nEOF\npwd\n'
  const start = source.indexOf('echo')
  const lines = shellPromptLines(source, start, source.length - 1)
  expect(lines.map(line => line.prompt)).toEqual([false, false, true])
  expect(lines.map(line => line.tokens.map(token => token.text).join('')).join('\n')).toBe('echo body\nEOF\npwd')
})
