import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundInlineCommandText, INLINE_COMMAND_OUTPUT_LIMIT, readInlineCommandOutput, retainInlineCommandOutput } from './inlineCommandOutput.js'
import { encodeInlineCommandResult } from '../../app/shared/inlineCommand.js'

test('small output, including empty stdout and stderr text, stays exact', async () => {
  for (const output of ['', 'line\n', 'stderr: failure\n']) {
    expect(await readInlineCommandOutput(output)).toEqual({ output })
  }
})

test('persisted output uses a real head and tail with exact omitted byte accounting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inline-output-'))
  try {
    const path = join(directory, 'output')
    for (const content of ['START\n' + 'middle\n'.repeat(10000) + 'UNIQUE-LAST-ERROR\n',
      '猫😀"\\\u0000\n'.repeat(10000) + 'UNIQUE-LAST-ERROR\n']) {
      await writeFile(path, content)
      const result = await readInlineCommandOutput(content.slice(0, 30000), path)
      expect(content.startsWith(result.output)).toBe(true)
      expect(content.endsWith(result.outputTail!)).toBe(true)
      expect(result.outputTail).toEndWith('UNIQUE-LAST-ERROR\n')
      expect(result.omittedBytes).toBe(Buffer.byteLength(content) - Buffer.byteLength(result.output) - Buffer.byteLength(result.outputTail!))
      expect(JSON.stringify(result.output).length + JSON.stringify(result.outputTail).length).toBeLessThanOrEqual(INLINE_COMMAND_OUTPUT_LIMIT)
      expect(result.output).not.toContain('\uFFFD')
      expect(result.outputTail).not.toContain('\uFFFD')
      const encoded = encodeInlineCommandResult({ ...result, runId: 'r', source: { engineSessionId: 'e', messageUuid: 'm', contentBlockIndex: 0, fenceOrdinal: 0 },
        command: '\u0001'.repeat(32000), cwd: '/tmp', status: 'failed', exitCode: 1 })
      expect(encoded.length).toBeLessThanOrEqual(262144)
      expect(await readFile(path, 'utf8')).toBe(content)
    }
    await writeFile(path, 'small\n')
    expect(await readInlineCommandOutput('small\n', path)).toEqual({ output: 'small\n', fullOutputPath: path })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('bounded progress preserves the selected edge and complete Unicode characters', () => {
  const text = '😀'.repeat(20000)
  for (const tail of [false, true]) {
    const value = boundInlineCommandText(text, 101, tail)
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(101)
    expect(value).toBe('😀'.repeat(value.length / 2))
  }
})

test('retention uses exclusive private artifacts and refuses output symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inline-output-'))
  try {
    const source = join(directory, 'source')
    const artifact = join(directory, 'artifact')
    const content = 'HEAD' + 'x'.repeat(40000) + 'TAIL'
    await writeFile(source, content)
    const result = await retainInlineCommandOutput(content.slice(0, 30000), artifact, source)
    expect(await readFile(artifact, 'utf8')).toBe(content)
    expect(result.outputTail).toEndWith('TAIL')
    await expect(retainInlineCommandOutput('replacement', artifact)).rejects.toThrow()
    expect(await readFile(artifact, 'utf8')).toBe(content)
    const link = join(directory, 'link')
    await symlink(source, link)
    await expect(retainInlineCommandOutput('head', join(directory, 'other'), link)).rejects.toThrow()
    await expect(readInlineCommandOutput('head', link)).rejects.toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
