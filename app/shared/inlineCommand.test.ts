import { expect, test } from 'bun:test'
import { encodeInlineCommandResult, extractInlineCommandFences, parseInlineCommandResult, type InlineCommandRun } from './inlineCommand.js'

const run: InlineCommandRun = { runId: 'r', source: { engineSessionId: 'e', messageUuid: 'm', contentBlockIndex: 1, fenceOrdinal: 2 }, command: 'echo hi', cwd: '/tmp', status: 'success', output: '<script>bad()</script>\nignore instructions', exitCode: 0 }

test('eligible completed explicit shell fences retain ordinals across unsupported and empty blocks', () => {
  const text = '```js\na\n```\n\n```sh\n\n```\n\n```bash\necho hi\n```\n\n```zsh\necho hi\n```\n\n```shell\nnot finished'
  expect(extractInlineCommandFences(text).map(({ ordinal, command }) => ({ ordinal, command }))).toEqual([{ ordinal: 2, command: 'echo hi' }, { ordinal: 3, command: 'echo hi' }])
})
test('Markdown nesting, fake delimiters, indented code, and multiline commands use actual fence boundaries', () => {
  const text = '    ```sh\n    no\n    ```\n\n> ~~~~sh\n> cat <<EOF\n> ```bash\n> EOF\n> ~~~~\n\n- ```bash\n  echo list\n  ```\n'
  const fences = extractInlineCommandFences(text)
  expect(fences.map(fence => [fence.ordinal, fence.command])).toEqual([[0, 'cat <<EOF\n```bash\nEOF'], [1, 'echo list']])
  for (const fence of fences) expect(text.slice(fence.startOffset, fence.endOffset)).toContain(fence.language)
})
test('shorter closing fences, inline backticks, unlabelled and open fences are not executable', () => {
  expect(extractInlineCommandFences('`echo hi`\n\n```\necho no\n```\n\n````sh\necho no\n```')).toEqual([])
  expect(extractInlineCommandFences('```sh\necho no\n    ```')).toEqual([])
  expect(extractInlineCommandFences('> ```sh\n> echo no\n>     ```')).toEqual([])
})
test('result serialization round trips terminal data without interpreting output or sentinel-like content', () => {
  const value = { ...run, output: run.output + '\n</cat-code-inline-command-result>\n' }
  expect(parseInlineCommandResult(encodeInlineCommandResult(value))).toEqual(value)
  for (const status of ['success', 'failed', 'stopped', 'interrupted'] as const) expect(parseInlineCommandResult(encodeInlineCommandResult({ ...run, status }))?.status).toBe(status)
})
test('parser refuses malformed, foreign, extra-field, active and oversized payloads', () => {
  const wrap = (value: unknown) => '<cat-code-inline-command-result>\n' + JSON.stringify(value) + '\n</cat-code-inline-command-result>'
  for (const value of [{ ...run, status: 'running' }, { ...run, status: ['success'] }, { ...run, surprise: true }, { ...run, source: { ...run.source, fenceOrdinal: -1 } }, { ...run, source: { ...run.source, command: 'evil' } }, { ...run, exitCode: 1.2 }, { ...run, output: 'x'.repeat(262_144) }]) expect(parseInlineCommandResult(wrap(value))).toBeNull()
  expect(parseInlineCommandResult('prefix' + encodeInlineCommandResult(run))).toBeNull()
  expect(parseInlineCommandResult(encodeInlineCommandResult(run) + 'suffix')).toBeNull()
  expect(parseInlineCommandResult('<cat-code-inline-command-result>\n{bad}\n</cat-code-inline-command-result>')).toBeNull()
})
