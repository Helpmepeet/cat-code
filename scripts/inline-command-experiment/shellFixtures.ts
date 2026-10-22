import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ShellKind = 'bash' | 'zsh'
export async function createShellFixture(options: { shell: ShellKind; command: string; profile?: string; prompt?: string }) {
  if (process.platform !== 'darwin') throw new Error('This fixture targets macOS system shells only')
  // zsh always reads this file, even with global startup files disabled.
  if (options.shell === 'zsh' && await Bun.file('/etc/zshenv').exists()) {
    throw new Error('Refusing real /etc/zshenv execution in the synthetic experiment')
  }
  const home = await mkdtemp(join(tmpdir(), 'inline-pty-'))
  await chmod(home, 0o700)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const ready = join(home, 'ready')
  const result = join(home, 'result')
  const payload = join(home, 'payload')
  try {
    await writeFile(payload, options.command, { mode: 0o600 })
    // The sentinel preserves all trailing newlines. No candidate bytes enter generated syntax.
    const integration = `
${options.shell === 'bash' ? 'set +m' : 'unsetopt MONITOR'}
PS1=${quote(options.prompt ?? 'synthetic> ')}
${options.profile ?? ''}
__inline_payload=$(command cat ${quote(payload)}; builtin printf .)
__inline_payload=\${__inline_payload%.}
builtin printf ready > ${quote(ready)}
builtin eval "$__inline_payload"
__inline_status=$?
builtin printf '%s' "$__inline_status" > ${quote(result)}
`
    await writeFile(join(home, options.shell === 'bash' ? '.bashrc' : '.zshrc'), integration, { mode: 0o600 })
    await writeFile(join(home, '.zshenv'), '', { mode: 0o600 })
    return {
      home, ready, result,
      argv: options.shell === 'bash'
        ? ['/bin/bash', '--noprofile', '--rcfile', join(home, '.bashrc'), '-i']
        : ['/bin/zsh', '-d', '-i'],
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C', LC_ALL: 'C', HISTFILE: '/dev/null' },
      cleanup: () => rm(home, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
