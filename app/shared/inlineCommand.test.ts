import { PROTOCOL_VERSION } from './protocol.js'
import { expect, test } from 'bun:test'
import { encodeInlineCommandResult, extractInlineCommandFences, isInteractiveShellCommand, parseInlineCommandResult, type InlineCommandRun } from './inlineCommand.js'
import { MAX_OUTBOUND_FRAME_BYTES } from './limits.js'

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

test('structured output facts round trip while old results stay compatible', () => {
  expect(parseInlineCommandResult(encodeInlineCommandResult(run))).toEqual(run)
  const structured = { ...run, output: 'head\n', outputTail: 'last error\n', omittedBytes: 150_000,
    fullOutputPath: '/tmp/tool-results/output.txt', startedAt: 1000, durationMs: 42, totalLines: 100 }
  expect(parseInlineCommandResult(encodeInlineCommandResult(structured))).toEqual(structured)
  const wrap = (value: unknown) => '<cat-code-inline-command-result>\n' + JSON.stringify(value) + '\n</cat-code-inline-command-result>'
  for (const extra of [{ outputTail: 'a'.repeat(24_001) }, { outputTail: 42 }, { omittedBytes: -1 },
    { totalLines: 1.2 }, { durationMs: Infinity }, { startedAt: 'now' }, { fullOutputPath: '' },
    { fullOutputPath: 'a'.repeat(8193) }, { omittedBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(parseInlineCommandResult(wrap({ ...run, ...extra }))).toBeNull()
  }
})

test('structured escaped output fits the result and outbound snapshot budgets', () => {
  const escaped = '"\\\u0000\t\n猫'.repeat(2000)
  const structured = { ...run, output: escaped, outputTail: escaped, omittedBytes: 1_000_000 }
  const encoded = encodeInlineCommandResult(structured)
  expect(encoded.length).toBeLessThanOrEqual(262_144)
  const snapshot = { kind: 'inline-command.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 's', generation: 'g',
    runs: Array.from({ length: 128 }, () => structured) }
  expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThan(MAX_OUTBOUND_FRAME_BYTES)
})

test('interactive hint matches only narrow standalone invocations', () => {
  for (const command of ['top', 'top -o cpu', 'htop', 'btop', 'vim file', 'vi file', 'nvim', 'nano', 'emacs',
    'less file', 'more file', 'man ls', 'watch date', 'tail -f log', 'tail -F log', 'tail -nf log',
    'vim "file with spaces"']) expect(isInteractiveShellCommand(command)).toBe(true)
  for (const command of ['top -l 2 -s 1', 'top -l2', 'tail -n 20 log', 'tail -n 20 -- -f', 'tail -- -F', 'tail -f log | head -n 20',
    'ps aux | less', 'git log | head', 'FOO=1 top', 'ssh host uptime', 'echo hi; top', '(top)',
    'top && echo done', 'top || echo done', 'top > file', 'top &', 'top\npwd', 'top $(echo -o cpu)',
    'top `echo -o cpu`', 'vim "unfinished', '']) expect(isInteractiveShellCommand(command)).toBe(false)
})
