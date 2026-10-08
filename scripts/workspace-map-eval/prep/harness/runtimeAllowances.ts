import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

export type RuntimeAllowances = { binaries: string[]; libraries: string[] }

export function runtimeAllowances(paths: string[]): RuntimeAllowances {
  const binaries = new Set<string>()
  const libraries = new Set<string>()
  for (const path of paths) {
    const resolved = realpathSync(path)
    binaries.add(path)
    binaries.add(resolved)
    let dependencies: string
    try {
      dependencies = execFileSync('/usr/bin/otool', ['-L', resolved], { encoding: 'utf8', maxBuffer: 1 << 20 })
    } catch {
      continue
    }
    for (const line of dependencies.split('\n').slice(1)) {
      const library = /^\s+(\/\S+?) \(compatibility version /.exec(line)?.[1]
      if (library && !['/System/', '/usr/bin/', '/usr/lib/', '/usr/libexec/', '/usr/share/', '/bin/', '/sbin/'].some(prefix => library.startsWith(prefix))) {
        libraries.add(library)
        try { libraries.add(realpathSync(library)) } catch {}
      }
    }
  }
  return { binaries: [...binaries], libraries: [...libraries] }
}
