import { expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createBashShellProvider } from './bashProvider.js'

const shells = ['/bin/bash', '/bin/zsh', '/bin/sh']

const commands = [
  ['awk with a single-quoted bang', "awk '!seen[$0]++' < input.txt"],
  ['a bang without a single quote', "printf \"bang!\\n\""],
  ['a single quote and the last background PID', "printf '%s\\n' 'bang!' \"$!\""],
  [
    'single and double quotes, dollars, and backticks',
    "printf '%s\\n' 'literal! $HOME \x60printf literal\x60' \"expanded! $HOME \x60printf tick\x60\"",
  ],
  ['a pipeline with quoted bangs', "printf '%s\\n' 'bang!' | tr '!' '?'"],
  ['a pipeline with an awk filter', "printf '%s\\n' 'same!' 'same!' | awk '!seen[$0]++'"],
  ['a heredoc', "cat <<'EOF'\n! $HOME \x60printf literal\x60 ' \"\nEOF"],
  ['a quoted multiline string', "printf '%s\\n' 'first!\nsecond!'"],
  ['multiple lines', "printf '%s\\n' 'first!'\nprintf '%s\\n' 'second!'"],
] as const

for (const shell of shells) {
  test.skipIf(!existsSync(shell))(shell + ': built commands match raw commands', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bash-provider-quoting-'))
    try {
      writeFileSync(join(cwd, 'input.txt'), 'one\none\ntwo\n')
      const provider = await createBashShellProvider(shell, { skipSnapshot: true })
      const env = { ...process.env, HOME: cwd, ZDOTDIR: cwd, BASH_ENV: '', ENV: '' }

      for (const [index, [label, command]] of commands.entries()) {
        const built = await provider.buildExecCommand(command, {
          id: 'quoting-' + index,
          useSandbox: false,
          workerScoped: true,
        })
        try {
          const raw = spawnSync(shell, provider.getSpawnArgs(command), {
            cwd,
            env,
            encoding: 'utf8',
            timeout: 5_000,
          })
          const wrapped = spawnSync(shell, provider.getSpawnArgs(built.commandString), {
            cwd,
            env,
            encoding: 'utf8',
            timeout: 5_000,
          })
          expect(raw.status, shell + ': ' + label).toBe(0)
          expect(
            { status: wrapped.status, stdout: wrapped.stdout, stderr: wrapped.stderr },
            shell + ': ' + label,
          ).toEqual({ status: raw.status, stdout: raw.stdout, stderr: raw.stderr })
          if (shell !== '/bin/sh') {
            const capture = spawnSync(
              shell,
              provider.getSpawnArgs("eval() { printf '%s' \"$1\"; }\n" + built.commandString),
              { cwd, env, encoding: 'utf8', timeout: 5_000 },
            )
            expect(capture.status, shell + ': ' + label).toBe(0)
            expect(capture.stdout, shell + ': ' + label).toBe(command)
          }
        } finally {
          rmSync(built.cwdFilePath, { force: true })
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test.skipIf(!existsSync(shell))(shell + ': a pipeline reads /dev/null instead of tool stdin', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bash-provider-pipe-'))
    try {
      const provider = await createBashShellProvider(shell, { skipSnapshot: true })
      const built = await provider.buildExecCommand('cat | wc -c', {
        id: 'quoting-pipe-stdin',
        useSandbox: false,
        workerScoped: true,
      })
      try {
        const result = spawnSync(shell, provider.getSpawnArgs(built.commandString), {
          cwd,
          env: { ...process.env, HOME: cwd, ZDOTDIR: cwd, BASH_ENV: '', ENV: '' },
          input: 'tool stdin must not reach cat',
          encoding: 'utf8',
          timeout: 5_000,
        })
        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe('0')
      } finally {
        rmSync(built.cwdFilePath, { force: true })
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}
