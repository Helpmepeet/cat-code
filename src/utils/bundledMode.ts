/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * In a `bun build --compile` binary, modules are served from the embedded
 * `/$bunfs/` virtual filesystem, so `import.meta.url` starts with that prefix.
 * `Bun.embeddedFiles` is unreliable here: it stays empty when the build has
 * no embedded asset files, even though the JS itself is embedded.
 */
export function isInBundledMode(): boolean {
  if (typeof Bun === 'undefined') return false
  try {
    return import.meta.url.startsWith('file:///$bunfs/')
  } catch {
    return false
  }
}
