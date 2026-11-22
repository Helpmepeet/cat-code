import { expect, test } from 'bun:test'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

async function runCodingFixture(root: string, scenario: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', new URL('./codeMode.fixture.ts', import.meta.url).pathname], {
    cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
      CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
      ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CODE_MODE_TEST_ROOT: root,
      CODE_MODE_TEST_SCENARIO: scenario, ...env },
  })
  const timer = setTimeout(() => child.kill(), 30_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`Code Mode fixture failed (${code}): ${stderr}\n${stdout}`)
  return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
}

async function withCodingEvidence(scenario: string, check: (evidence: any, workspace: string) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-host-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    await check(await runCodingFixture(root, scenario, env), join(root, 'workspace'))
  } finally { await rm(root, { recursive: true, force: true }) }
}

function scriptResultInRequest(messages: BetaMessageParam[], toolUseId: string): string {
  const result = messages
    .flatMap(message => typeof message.content === 'string' ? [] : message.content)
    .find(block => block.type === 'tool_result' && block.tool_use_id === toolUseId)
  if (result?.type !== 'tool_result' || typeof result.content !== 'string') {
    throw new Error(`Missing Script text result for ${toolUseId}`)
  }
  return result.content
}

test('Script discovery ranks exact names and aliases above text matches', async () => {
  await withCodingEvidence('search-exact', async evidence => {
    const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode')?.toolUseResult
    expect(result?.status).toBe('completed')
    expect(JSON.parse(result.output.split('\n\n[Code Mode]')[0])).toEqual({
      name: 'Bash',
      alias: 'SendUserMessage',
      partial: 'apply_patch',
    })
  })
}, 35_000)

test('real-engine Code Mode catches Bash failure, executes the next effect, and retains variables', async () => {
  await withCodingEvidence('coding', async (evidence, workspace) => {
    const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
    expect(results).toHaveLength(2)
    expect(results[0].status).toBe('completed')
    expect(JSON.parse(results[0].output.split('\n\n[Code Mode]')[0]).caught).toBe(true)
    expect(JSON.parse(results[0].output.split('\n\n[Code Mode]')[0]).failedDiagnostic).toContain('diagnostic-from-failed-test')
    expect(JSON.parse(results[0].output.split('\n\n[Code Mode]')[0]).failed).toBe(true)
    expect(results[0].calls.map((call: any) => call.status)).toEqual(['completed', 'completed', 'completed', 'failed', 'failed', 'completed'])
    expect(await readFile(join(workspace, 'sample.txt'), 'utf8')).toBe('after\n')
    expect(results[0].changedFiles).toContainEqual({ path: join(workspace, 'sample.txt') })
    expect(await readFile(join(workspace, 'survived.txt'), 'utf8')).toBe('survived')
    expect(results[1].error).toBeUndefined()
    expect(results[1].status).toBe('completed')
    const retained = JSON.parse(results[1].output.split('\n\n[Code Mode]')[0])
    expect(retained.retained).toBe(true)
    expect(retained.discovery.schemaComplete).toBe(true)
    expect(retained.discovery.inputSchema.properties.command).toBeDefined()
    for (const message of evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode')) {
      expect(message.message.content.find((block: any) => block.type === 'tool_result').content).toBe(message.toolUseResult.output)
    }
    expect(evidence.transcript.filter((message: any) => message.codeMode).every((message: any) => message.isVirtual)).toBe(true)
    expect(evidence.transcript.filter((message: any) => message.codeMode)).toHaveLength(12)
    expect(evidence.transcript.findIndex((message: any) => message.codeMode)).toBeLessThan(
      evidence.transcript.findIndex((message: any) => message.toolUseResult?.kind === 'code-mode'),
    )
  })
}, 35_000)

test('ordinary child failure details reach the Script catch and uncaught cell result', async () => {
  await withCodingEvidence('shell-failure-detail', async evidence => {
    const caught = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
    const uncaught = scriptResultInRequest(evidence.modelBodies[3].messages, 'cell-2')
    expect(caught.split('\n\n[Code Mode]')[0]).toContain('last-failure-detail')
    expect(uncaught).toContain('last-failure-detail')
    expect(uncaught).toContain('[Code Mode] failed')
  })
}, 35_000)

test('Bash previews and cut stdout are marked incomplete before Script can consume them', async () => {
  await withCodingEvidence('shell-completeness', async evidence => {
    const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
    expect(JSON.parse(result.split('\n\n[Code Mode]')[0]!)).toEqual({ contentComplete: false, dataComplete: false, tail: false })
  })
}, 35_000)

for (const [scenario, marker] of [['shell-many-paths', 'item-69.txt'], ['shell-heredoc', './fixtures/item-69.txt']] as const) {
  test(`instruction preflight accepts ${scenario}`, async () => {
    await withCodingEvidence(scenario, async evidence => {
      const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
      expect(result).toContain(marker)
      expect(result).toContain('[Code Mode] completed')
      if (scenario === 'shell-heredoc') {
        expect(result).toContain('heredoc-follow-up')
        expect(JSON.stringify(evidence.modelBodies[1].messages)).not.toContain('HEREDOC-DATA-MUST-NOT-LOAD')
      }
    })
  }, 35_000)
}

test('instruction preflight still yields for a qualifying Bash path after the 64th operand', async () => {
  await withCodingEvidence('shell-late-instructions', async evidence => {
    const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
    expect(result).toContain('[Code Mode] yielded')
    expect(JSON.stringify(evidence.modelBodies[1].messages)).toContain('LATE-SHELL-INSTRUCTIONS')
    expect(result).not.toContain('must-not-be-read')
  })
}, 35_000)

test('a real path after a quoted heredoc still activates its instructions before Bash runs', async () => {
  await withCodingEvidence('shell-heredoc-instructions', async evidence => {
    expect(scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')).toContain('[Code Mode] yielded')
    const messages = JSON.stringify(evidence.modelBodies[1].messages)
    expect(messages).toContain('HEREDOC-FOLLOW-UP-INSTRUCTIONS')
    expect(messages).not.toContain('HEREDOC-DATA-MUST-NOT-LOAD')
    expect(messages).not.toContain('must-not-be-read')
  })
}, 35_000)

for (const variant of ['pass', 'fail', 'none', 'spaces', '70', 'overflow', 'warning', 'timeout']) {
  test(`the rendered sh example runs through the real engine with ${variant}`, async () => {
    await withCodingEvidence('shell-example', async (evidence, workspace) => {
      const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
      const script = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
      expect(script.status).toBe('completed')
      expect(script.calls.map((call: any) => call.name)).toEqual(variant === 'none' || variant === 'overflow' ? ['Bash', 'Bash'] : ['Bash', 'Bash', 'Bash'])
      expect(script.calls[0].input.command).toBe("rg -l 'function loadConfig' src")
      expect(script.calls[1].input.command).toBe("rg -l 'loadConfig\\(' src -g '*.test.ts'")
      if (variant === 'overflow') {
        expect(result).toContain('sh could not deliver complete stdout')
        expect(script.calls[1].result.dataComplete).toBe(false)
      } else if (variant === 'none') {
        expect(JSON.parse(result.split('\n\n[Code Mode]')[0]!).files).toBe('none found')
      } else {
        const selected = JSON.parse(result.split('\n\n[Code Mode]')[0]!)
        expect(selected.files.split('\n')).toHaveLength(variant === '70' ? 70 : variant === 'warning' ? 2 : 1)
        if (variant === 'spaces') expect(selected.files).toBe('src/contains spaces.test.ts')
        if (variant === 'warning') expect(selected.files).toBe('fixture-stderr-warning\nsrc/matching-0.test.ts')
        if (variant === 'fail') expect(selected.tests).toContain('example-failure-detail')
        else if (variant === 'timeout') {
          expect(selected.tests).toContain('still running')
          const taskId = script.calls[2].result.data?.backgroundTaskId
          expect(taskId).toBeString()
          expect(selected.tests).toContain(taskId)
          expect(evidence.firstTurnTasks[taskId]).toMatchObject({ type: 'local_bash', isBackgrounded: true })
          expect(evidence.sawLiveShellTask).toBe(true)
          expect(await readFile(join(workspace, 'sh-test-finished.txt'), 'utf8')).toBe('finished')
          expect(evidence.shellTaskOutput).toContain('fixture-background-stderr')
        }
        else expect(selected.tests).toBe('passed')
      }
    }, {
      CODE_MODE_EXAMPLE_VARIANT: variant,
      ...(variant === 'timeout' ? { BASH_DEFAULT_TIMEOUT_MS: '3400' } : {}),
      PATH: [dirname(process.execPath), ...(process.env.PATH ?? '').split(':')].join(':'),
    })
  }, 35_000)
}

for (const shell of ['/bin/bash', '/bin/zsh']) {
  if (!Bun.file(shell).size) continue
  test(`sh preserves argv and rejects ambiguous interpolation before Bash dispatch via ${shell}`, async () => {
    await withCodingEvidence('shell-tag-validation', async evidence => {
      const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
      const script = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
      expect(script.calls.map((call: any) => call.status)).toEqual(['completed', 'completed', 'completed'])
      expect(JSON.parse(result.split('\n\n[Code Mode]')[0]!)).toEqual({
        values: "<space name>\n<apost'rophe>\n<$literal>\n<semi;colon>\n<left\nright>\n<>\n<42>\n",
        dash: '-leading\n', raw: '` ${literal}\n', errors: Array(22).fill(true),
      })
    }, { CLAUDE_CODE_SHELL: shell })
  }, 35_000)
}

test('sh reports the authenticated Bash refusal even if guest output repeats the reason', async () => {
  await withCodingEvidence('shell-helper-refusal', async evidence => {
    expect(evidence.permissionRequests).toHaveLength(1)
    expect(evidence.permissionRequests[0].request.tool_name).toBe('Bash')
    expect(evidence.forbidden).toBeNull()
    const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
    expect(result).toContain('[Code Mode] blocked')
    const [guest, receipt] = result.split('\n\n[Code Mode]')
    expect(guest).toContain('Declined by the user.')
    expect(receipt).toContain('Bash: Declined by the user.')
  })
}, 35_000)

for (const shell of ['/bin/bash', '/bin/zsh']) {
  if (!Bun.file(shell).size) continue
  test(`sh supports shell composition without changing argument boundaries in ${shell}`, async () => {
    await withCodingEvidence('shell-compound', async evidence => {
      const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
      const value = "safe; literal ' marker"
      expect(JSON.parse(result.split('\n\n[Code Mode]')[0]!)).toEqual([
        value + '\n', value + '\n42\n', '--\n-dash\n' + value + '\nchain', value,
        '--glob=x.ts\n' + value + '\n', 'src/fixture.ts:matching value\n', 'matching value\n',
        'line 1\nline 2\nline 3\nline 4\nline 5\n',
        '<add>\n<-->\n<file with spaces.txt>\n<second file>\n<commit>\n<-m>\n<msg>\n',
        '<log>\n<--format=%H>\n<fixture revision>\n',
        value + 'file with spaces.txt',
      ])
    }, { CLAUDE_CODE_SHELL: shell })
  }, 35_000)
  test(`sh and tools.call present identical Bash permissions for interpreting commands in ${shell}`, async () => {
    await withCodingEvidence('shell-permission-parity', async evidence => {
      const requests = evidence.permissionRequests
      expect(requests).toHaveLength(8)
      for (let index = 0; index < requests.length; index += 2) {
        expect(requests[index].request.tool_name).toBe('Bash')
        expect(requests[index].request.input).toEqual(requests[index + 1].request.input)
      }
      const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
      const outcomes = JSON.parse(result.split('\n\n[Code Mode]')[0]!) as boolean[]
      expect(outcomes).toHaveLength(8)
      for (let index = 0; index < outcomes.length; index += 2) expect(outcomes[index]).toBe(outcomes[index + 1])
    }, { CLAUDE_CODE_SHELL: shell })
  }, 35_000)
}

test('sh returns a rejected template as a result and the Script continues', async () => {
  await withCodingEvidence('shell-rejected-result', async evidence => {
    const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
    const [before, rejection, after] = result.split('\n')
    expect(before).toBe('before')
    expect(after).toBe('after')
    expect(JSON.parse(rejection!)).toMatchObject({ isError: true, content: expect.stringContaining('separate argument') })
    expect(evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult.calls).toEqual([])
  })
}, 35_000)

test('a guest variable named sh works locally and the built-in returns in the next cell', async () => {
  await withCodingEvidence('shell-shadow', async evidence => {
    expect(scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')).toStartWith('fixture-local')
    expect(scriptResultInRequest(evidence.modelBodies[3].messages, 'cell-2')).toStartWith('restored')
  })
}, 35_000)

test('sh returns untrimmed mixed Bash output and withholds invalid UTF-8', async () => {
  await withCodingEvidence('shell-exact', async evidence => {
    const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
    const selected = JSON.parse(result.split('\n\n[Code Mode]')[0]!)
    expect(selected).toMatchObject({ stdout: '\n  keep \n \nfixture-warning', complete: true, binaryUnavailable: true })
    expect(selected.ordinary).toContain('fixture-warning')
  })
}, 35_000)

test('sh retains the beginning and end of an oversized stderr failure in the Bash output file', async () => {
  await withCodingEvidence('shell-large-stderr-failure', async (evidence, workspace) => {
    const content = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
    const saved = content.match(/Full output saved to: ([^\n]+)/)?.[1]
    expect(saved).toStartWith(join(dirname(workspace), 'config') + '/')
    const full = await readFile(saved!, 'utf8')
    expect(full).toStartWith('fixture-stderr-start\n')
    expect(full).toEndWith('\nfixture-stderr-end\n')
  })
}, 35_000)

async function waitForFixtureFile(path: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs
  while (!await Bun.file(path).exists() && performance.now() < deadline) await Bun.sleep(25)
  return Bun.file(path).exists()
}

test('a detached sh child can write stderr after its engine process exits', async () => {
  await withCodingEvidence('shell-detached', async (evidence, workspace) => {
    expect(scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')).toStartWith('false')
    await writeFile(join(workspace, 'release-detached'), '')
    expect(await waitForFixtureFile(join(workspace, 'detached-finished'), 1500)).toBe(true)
  }, { CODE_MODE_FORCE_FIXTURE_EXIT: '1', CLAUDE_CODE_SHELL: '/bin/bash' })
}, 35_000)

test('a detached sh child does not hold the engine process open', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-detached-')))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(join(root, 'config'))
    await mkdir(workspace)
    const fixture = runCodingFixture(root, 'shell-detached', { CLAUDE_CODE_SHELL: '/bin/bash' })
    void fixture.catch(() => {})
    try {
      const ready = await Promise.race([waitForFixtureFile(join(root, 'evidence.json'), 10_000), fixture.then(() => true)])
      expect(ready).toBe(true)
      expect(await Promise.race([fixture.then(() => true), Bun.sleep(1500).then(() => false)])).toBe(true)
    } finally {
      await writeFile(join(workspace, 'release-detached'), '')
      await fixture
      await waitForFixtureFile(join(workspace, 'detached-finished'), 1000)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 35_000)

for (const command of ["echo hi\nrm nested/note.txt", "printf 'x'\ncat nested/note.txt",
  "# clean up\nrm nested/note.txt", "true # ok\ncat nested/note.txt",
  "printf 'x\ncat nested/note.txt'\ntrue"]) {
  const isQuotedData = command.includes("note.txt'")
  test(`Bash instruction preflight treats shell newlines correctly for ${JSON.stringify(command)}`, async () => {
    await withCodingEvidence('shell-newline', async (evidence, workspace) => {
      const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
      expect(result).toContain(isQuotedData ? '[Code Mode] completed' : '[Code Mode] yielded')
      const modelMessages = JSON.stringify(evidence.modelBodies[1].messages)
      expect(modelMessages.includes('NEWLINE-INSTRUCTIONS')).toBe(!isQuotedData)
      expect(await readFile(join(workspace, 'nested/note.txt'), 'utf8')).toBe('fixture-note')
    }, { CODE_MODE_NEWLINE_COMMAND: command })
  }, 35_000)
}

const preflightCases = [
  ['if', 'echo start\nif true\nthen\n  cat nested/note.txt\nfi', true],
  ['for', 'echo start\nfor i in 1\ndo\n  cat nested/note.txt\ndone', true],
  ['while', 'echo start\nwhile true\ndo\n cat nested/note.txt\n break\ndone', true],
  ['case', 'echo start\ncase a in\na)\n cat nested/note.txt ;;\nesac', true],
  ['function', 'echo start\nshow_note() {\n cat nested/note.txt\n}\nshow_note', true],
  ['subshell', 'echo start\n(\n cat nested/note.txt\n)', true],
  ['brace group', 'echo start\n{\n cat nested/note.txt\n}', true],
  ['negation', 'echo start\n! cat nested/note.txt', true],
  ['substitution', 'echo $(cat nested/note.txt)', true],
  ['assignment substitution', 'X="$(cat nested/note.txt)"', true],
  ['backtick substitution', 'echo "`cat nested/note.txt`"', true],
  ['backticks nested with escapes', 'echo `echo \\`cat nested/note.txt\\``', true],
  ['nested combinations', 'echo start\n{\n for i in 1; do\n  echo "$(if true; then echo `cat nested/note.txt`; fi)"\n done\n}', true],
  ['conditional file test', 'echo start\nif [[ -f nested/note.txt ]]\nthen\n true\nfi', true],
  ['redirect in a substitution', 'X="$(cat < nested/note.txt)"', true],
  ['expanding heredoc', 'echo start\ncat <<END\n$(cat nested/note.txt)\nEND', true],
  ['single quotes', "echo start\nprintf '%s' '\$(cat nested/note.txt)'", false],
  ['comment', "echo start\n# $(cat nested/note.txt)\ntrue", false],
  ['literal heredoc', "true\ncat <<'END'\n$(cat nested/note.txt)\nEND\ntrue", false],
  ['inline substitution with cd', 'root="$(cd .. && pwd)"; echo "$root"', false],
  ['later substitution with cd', 'echo start\nroot="$(cd .. && pwd)"', false],
] as const

for (const [label, command, load] of preflightCases) {
  test(`nested Bash preflight handles ${label}`, async () => {
    await withCodingEvidence('shell-newline', async evidence => {
      const result = scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')
      expect(result).toContain(load ? '[Code Mode] yielded' : '[Code Mode] completed')
      expect(JSON.stringify(evidence.modelBodies[1].messages).includes('NEWLINE-INSTRUCTIONS')).toBe(load)
      if (load) expect(result).not.toContain('fixture-note')
    }, { CODE_MODE_NEWLINE_COMMAND: command })
  }, 35_000)
}

for (const [setting, expectedPeak] of [[undefined, 10], ['2', 2], ['20', 10], ['0', 10]] as const) {
  test(`Script limits parallel Glob calls to ${expectedPeak} with concurrency setting ${setting ?? 'unset'}`, async () => {
    await withCodingEvidence('parallel-glob', async (evidence, workspace) => {
      expect(evidence.peakGlob).toBe(expectedPeak)
      expect(evidence.globTrace.slice(0, expectedPeak)).toEqual(Array.from(
        { length: expectedPeak }, (_, index) => index === 1 ? 'start:fail.txt' : `start:file-${index}.txt`,
      ))
      expect(evidence.globTrace.indexOf(`start:file-${expectedPeak}.txt`)).toBeGreaterThan(expectedPeak)
      expect(evidence.globTrace.at(-2)).toBe('start:created.txt')
      expect(await readFile(join(workspace, 'created.txt'), 'utf8')).toBe('created')
      const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
      expect(result.status).toBe('completed')
      expect(result.calls).toHaveLength(13)
      expect(result.calls.filter((call: any) => call.status !== 'completed')).toMatchObject([
        { name: 'Glob', input: { pattern: 'fail.txt' }, status: 'failed' },
      ])
      expect(JSON.parse(result.output.split('\n\n[Code Mode]')[0])).toEqual({ failed: true, found: ['created.txt'] })
      const audit = evidence.transcript.filter((message: any) => message.codeMode)
      const writeStart = audit.findIndex((message: any) => message.type === 'assistant' && message.message.content[0].name === 'Write')
      expect(audit.slice(0, writeStart).filter((message: any) => message.type === 'user')).toHaveLength(11)
    }, {
      CODE_MODE_TEST_EXPECTED_GLOB_OVERLAP: String(expectedPeak),
      ...(setting === undefined ? {} : { CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: setting }),
    })
  }, 35_000)
}

test('final-input instructions fence queued Glob and Write calls before their effects', async () => {
  await withCodingEvidence('parallel-glob-fence', async evidence => {
    expect(evidence.globTrace).toEqual([])
    expect(evidence.forbidden).toBeNull()
    const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
    expect(result.status).toBe('yielded')
    expect(result.calls.map((call: any) => call.status)).toEqual(['blocked', 'blocked', 'blocked'])
    expect(JSON.stringify(evidence.modelBodies)).toContain('PARALLEL-GLOB-INSTRUCTIONS')
  })
}, 35_000)

test('partial Code Mode receipt lists the real notebook edit and excludes the failed one', async () => {
  await withCodingEvidence('notebook', async (evidence, workspace) => {
    const notebookPath = join(workspace, 'analysis.ipynb')
    expect(JSON.parse(await readFile(notebookPath, 'utf8')).cells[0].source).toBe('After')
    expect(JSON.parse(await readFile(join(workspace, 'unread.ipynb'), 'utf8')).cells[0].source).toBe('Before')
    const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode')?.toolUseResult
    expect(result).toMatchObject({
      status: 'failed', error: expect.stringContaining('Notebook fixture stopped'),
      calls: [{ name: 'NotebookEdit', status: 'completed' }, { name: 'NotebookEdit', status: 'failed' }],
      changedFiles: [{ path: notebookPath }],
    })
  })
}, 35_000)

test('Script Read sends a native PNG without exposing its bytes to Script', async () => {
  await withCodingEvidence('script-image', async (evidence, workspace) => {
    expect(evidence.modelBodies[0].tools.map((tool: { name: string }) => tool.name)).not.toContain('Read')
    const request: BetaMessageParam[] = evidence.modelBodies[1].messages
    const blocks = request.flatMap(message => typeof message.content === 'string' ? [] : message.content)
    const images = blocks.flatMap(block => {
      if (block.type === 'image') return [block]
      return block.type === 'tool_result' && Array.isArray(block.content)
        ? block.content.filter(nested => nested.type === 'image')
        : []
    })
    expect(blocks.filter(block => block.type === 'tool_use').map(block => block.name)).toEqual(['REPL'])
    expect(blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id)).toEqual(['cell-0'])
    expect(scriptResultInRequest(request, 'cell-0')).toContain('"originalType":"image"')
    const png = (await readFile(join(workspace, 'pixel.png'))).toString('base64')
    expect(images.map(image => image.source)).toEqual([
      { type: 'base64', media_type: 'image/png', data: png },
    ])
    expect(JSON.stringify(request).split(png)).toHaveLength(2)
  })
}, 35_000)

test('Script Read delivers the supplemental PDF once, outside its guest result', async () => {
  await withCodingEvidence('script-pdf', async (evidence, workspace) => {
    const pdf = (await readFile(join(workspace, 'page.pdf'))).toString('base64')
    const request: BetaMessageParam[] = evidence.modelBodies[1].messages
    const blocks = request.flatMap(message => typeof message.content === 'string' ? [] : message.content)
    expect(blocks.filter(block => block.type === 'document').map(block => block.source)).toEqual([
      { type: 'base64', media_type: 'application/pdf', data: pdf },
    ])
    expect(JSON.stringify(request).split(pdf)).toHaveLength(2)
    const guest = JSON.parse(scriptResultInRequest(request, 'cell-0').split('\n\n[Code Mode]')[0]!)
    expect(guest).toMatchObject({ dataComplete: false, isError: false })
  })
}, 35_000)

test('Script Read lets NotebookEdit change only the notebook that Script read', async () => {
  await withCodingEvidence('script-notebook', async (evidence, workspace) => {
    expect(evidence.modelBodies[0].tools.map((tool: { name: string }) => tool.name)).not.toContain('NotebookEdit')
    expect(scriptResultInRequest(evidence.modelBodies[1].messages, 'cell-0')).toContain('Read the cell in Script')
    expect(JSON.stringify(evidence.modelBodies[1].messages)).not.toContain('private-notebook-cell')
    const afterEdit = scriptResultInRequest(evidence.modelBodies[2].messages, 'cell-1')
    expect(afterEdit).toContain('File has not been read yet')
    expect(afterEdit).toContain('"editFailed":false')
    expect(JSON.parse(await readFile(join(workspace, 'analysis.ipynb'), 'utf8')).cells[0].source).toBe('After')
    expect(JSON.parse(await readFile(join(workspace, 'unread.ipynb'), 'utf8')).cells[0].source).toBe('private-notebook-cell')
  })
}, 35_000)

test('a new chat starts in Code Mode and Script retains the real coding tools', async () => {
  await withCodingEvidence('code-first', async (evidence, workspace) => {
    const names = evidence.modelBodies.map((body: { tools: { name: string }[] }) =>
      body.tools.map(tool => tool.name))
    expect(names).toHaveLength(2)
    for (const request of names) {
      expect(request).toContain('REPL')
      expect(request).toContain('TaskStop')
      for (const name of ['Bash', 'Read', 'Write', 'Edit']) expect(request).not.toContain(name)
    }
    expect(await readFile(join(workspace, 'sample.txt'), 'utf8')).toBe('after\n')
    expect(await readFile(join(workspace, 'survived.txt'), 'utf8')).toBe('survived')
  })
}, 35_000)

test('new Code Mode chats reopen in Code Mode without enabling it on older chats', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-restore-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const chat = crypto.randomUUID()
    const run = (id: string, fresh = false, ephemeral = false) => runCodingFixture(root, 'code-first-reopen', {
      CODE_MODE_TEST_CHAT_ID: id,
      CODE_MODE_TEST_FRESH: fresh ? '1' : '0',
      CODE_MODE_TEST_EPHEMERAL: ephemeral ? '1' : '0',
    })
    const names = (evidence: { modelBodies: { tools: { name: string }[] }[] }) =>
      evidence.modelBodies[0]!.tools.map(tool => tool.name)
    expect(names(await run(chat, true))).not.toContain('Bash')
    const saved = join(root, 'config', 'code-mode-preferences', `${chat}.mode`)
    expect((await stat(saved)).mode & 0o077).toBe(0)
    expect(names(await run(chat))).not.toContain('Bash')
    const other = crypto.randomUUID()
    expect(names(await run(other))).toContain('Bash')
    expect(names(await run(other, true, true))).not.toContain('Bash')
    expect(names(await run(other))).toContain('Bash')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 35_000)

test('a new persistent chat keeps its direct tools when Code Mode enrollment cannot be saved', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-save-failed-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    await writeFile(join(root, 'config', 'code-mode-preferences'), 'not a directory')
    const evidence = await runCodingFixture(root, 'code-first-reopen', {
      CODE_MODE_TEST_CHAT_ID: crypto.randomUUID(),
      CODE_MODE_TEST_FRESH: '1',
    })
    expect(evidence.modelBodies[0].tools.map((tool: { name: string }) => tool.name)).toContain('Bash')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 35_000)
