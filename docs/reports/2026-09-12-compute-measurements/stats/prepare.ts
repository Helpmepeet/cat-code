import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? process.cwd())
const root = mkdtempSync(join(tmpdir(), 'cat-code-stats-benchmark-'))
const modules = join(root, 'modules')
mkdirSync(modules)
for (const name of readdirSync(join(repo, 'src/utils'))) {
  symlinkSync(join(repo, 'src/utils', name), join(modules, name))
}
const manifest = {
  repo,
  beforeCommit: 'd9f5eef5dad750ceffe411e6913692e8789bc9ca',
  afterCommit: 'd58b9f10f7fb6d31a033045bc7321bbccccaf885',
  sourcePath: 'src/utils/stats.ts',
  blobs: {} as Record<string, { path: string; sha256: string }>,
}
for (const [variant, commit] of [['before', manifest.beforeCommit], ['after', manifest.afterCommit]]) {
  const extracted = Bun.spawnSync(['git', '-C', repo, 'show', `${commit}:src/utils/stats.ts`])
  if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString())
  const path = join(modules, `stats-${variant}.ts`)
  writeFileSync(path, extracted.stdout)
  manifest.blobs[variant!] = {
    path,
    sha256: createHash('sha256').update(extracted.stdout).digest('hex'),
  }
}
copyFileSync(join(dirname(import.meta.path), 'run.ts'), join(root, 'run.ts'))
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(root)
