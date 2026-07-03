const OWNED_DIAGNOSTIC = /^app\/(?:sidecar|shared)\/.*: error TS\d+:/

export function collectOwnedDiagnostics(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => OWNED_DIAGNOSTIC.test(line))
}

function countDiagnostics(output: string): number {
  return output.split(/\r?\n/).filter(line => /: error TS\d+:/.test(line))
    .length
}

export function hasTypecheckInfrastructureFailure(
  exitCode: number,
  output: string,
): boolean {
  return exitCode !== 0 && countDiagnostics(output) === 0
}

if (import.meta.main) {
  const repoRoot = new URL('../..', import.meta.url).pathname
  const result = Bun.spawnSync(
    ['bunx', 'tsc', '--noEmit', '-p', 'app/sidecar/tsconfig.json', '--pretty', 'false'],
    {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const output =
    result.stdout.toString() +
    (result.stderr.length > 0 ? `\n${result.stderr.toString()}` : '')
  const ownedDiagnostics = collectOwnedDiagnostics(output)

  if (hasTypecheckInfrastructureFailure(result.exitCode, output)) {
    console.error(output.trim())
    process.exit(result.exitCode || 1)
  }

  if (ownedDiagnostics.length > 0) {
    console.error(ownedDiagnostics.join('\n'))
    process.exit(1)
  }

  const ignoredCount = countDiagnostics(output)
  console.log(
    `Scoped sidecar typecheck passed (${ignoredCount} upstream diagnostics ignored).`,
  )
}
