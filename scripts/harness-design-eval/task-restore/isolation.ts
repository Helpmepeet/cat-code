import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { runtimeAllowances } from '../../workspace-map-eval/prep/harness/runtimeAllowances.js'

export function environment(home: string, temp: string, mode: string) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'dumb',
    HOME: home, CLAUDE_CONFIG_DIR: join(home, '.cat-code'), TMPDIR: temp, CLAUDE_CODE_TMPDIR: temp, TMPPREFIX: join(temp, 'zsh'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    ANTHROPIC_API_KEY: 'sk-ant-isolated-eval-placeholder',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_ENABLE_TASKS: mode === 'task' ? '1' : 'false',
    CLAUDE_CODE_MAX_RETRIES: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
    ANTHROPIC_SMALL_FAST_MODEL: 'claude-sonnet-5-5',
  }
}
const q = (path: string) => JSON.stringify(path)
// Agent descendants inherit this profile. Private runner/grader/other runs are
// outside stage; the engine copy's scripts/docs/test sources are denied.
export function profile(stage: string, engine: string, dependencies: string, port: number) {
  const runtime = runtimeAllowances([process.execPath, ...['git', 'rg', 'node'].flatMap(n => Bun.which(n) ?? [])])
  const parents = new Set<string>(['/', '/private', '/private/tmp', '/Users', '/opt', '/opt/homebrew'])
  for (const path of [stage, engine, dependencies, ...runtime.binaries, ...runtime.libraries]) {
    for (let p = dirname(path); p !== dirname(p); p = dirname(p)) parents.add(p)
  }
  return `(version 1)(allow default)
(deny process-exec (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))
(deny network*)
(allow network* (local unix-socket))
(allow network-outbound (remote ip "localhost:${port}"))
(deny file-read*)(deny file-write*)
(allow file-read-metadata ${[...parents].map(p => `(literal ${q(p)})`).join(' ')})
(allow file-read* (literal "/") (subpath ${q(stage)}) (subpath ${q(engine)}) (subpath ${q(dependencies)})
 (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple")
 (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
 ${runtime.binaries.map(p => `(literal ${q(p)})`).join(' ')}
 ${runtime.libraries.map(p => `(subpath ${q(dirname(p))})`).join(' ')})
(deny file-read* (subpath ${q(join(engine, 'scripts'))}) (subpath ${q(join(engine, 'docs'))})
 (regex ${q('^' + engine + '/.*\\.test\\.tsx?$')}))
(allow file-write* (subpath ${q(stage)}) (literal "/dev/null"))`
}
export function dependenciesAt(repo: string) { return realpathSync(join(repo, 'node_modules')) }
