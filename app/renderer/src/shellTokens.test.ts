import { expect, test } from 'bun:test'
import { shellTokens } from './shellTokens.js'

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
