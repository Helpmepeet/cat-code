import { constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

export const DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL =
  'com.cat-code.deferred-continuation'
export const DEFERRED_CONTINUATION_WORKER_ARGUMENT =
  'deferred-continuation-worker'

const execFileAsync = promisify(execFile)

// `launchctl bootout` cannot report whether a job was unloaded: a plist that was
// never loaded and a job that refused to unload both exit non-zero (EIO on
// current macOS). The loaded state queried afterwards is the only authoritative
// signal, so the executor reports outcomes instead of throwing.
export type LaunchctlRunResult =
  | { outcome: 'ok' }
  | { outcome: 'exit'; code: number }
  | { outcome: 'unavailable' }

export type LaunchctlExecutor = (args: string[]) => Promise<LaunchctlRunResult>

// `launchctl print` exits 113 ("Could not find service") when no such job is
// loaded in the domain.
const LAUNCHCTL_SERVICE_NOT_FOUND = 113

const defaultLaunchctlExecutor: LaunchctlExecutor = async args => {
  try {
    await execFileAsync('launchctl', args)
    return { outcome: 'ok' }
  } catch (error) {
    // execFile reports a numeric exit status, but a string errno when launchctl
    // could not be spawned at all.
    const code = (error as { code?: unknown }).code
    return typeof code === 'number' ? { outcome: 'exit', code } : { outcome: 'unavailable' }
  }
}

async function getDeferredContinuationLoadState(
  run: LaunchctlExecutor,
): Promise<'loaded' | 'not_loaded' | 'unknown'> {
  const result = await run([
    'print',
    `gui/${process.getuid!()}/${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}`,
  ])
  if (result.outcome === 'ok') return 'loaded'
  if (result.outcome === 'exit' && result.code === LAUNCHCTL_SERVICE_NOT_FOUND) {
    return 'not_loaded'
  }
  return 'unknown'
}

export function getDeferredContinuationLaunchAgentPath(
  home = homedir(),
): string {
  return join(
    home,
    'Library',
    'LaunchAgents',
    `${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}.plist`,
  )
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

export function renderDeferredContinuationLaunchAgent(
  executablePath: string,
): string {
  if (!isAbsolute(executablePath)) {
    throw new Error('Background continuation executable must be absolute')
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executablePath)}</string>
    <string>${DEFERRED_CONTINUATION_WORKER_ARGUMENT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`
}

export async function validateStableDeferredContinuationExecutable(
  candidate: string,
): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Background continuation is only supported on macOS')
  }
  if (!isAbsolute(candidate)) {
    throw new Error('Background continuation requires an absolute executable path')
  }
  const canonical = await realpath(candidate)
  const info = await lstat(canonical)
  await access(canonical, fsConstants.X_OK)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Background continuation executable is not a regular file')
  }
  const lower = canonical.toLowerCase()
  if (
    lower.endsWith('/bun') ||
    lower.endsWith('/node') ||
    lower.includes('/node_modules/') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx')
  ) {
    throw new Error(
      'Background continuation requires an installed Cat Code executable',
    )
  }
  return canonical
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeLaunchAgentAtomically(path: string, contents: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temp = join(parent, `.${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}.${randomUUID()}.tmp`)
  const handle = await open(
    temp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  )
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  await chmod(path, 0o600)
  await syncDirectory(parent)
}

export type DeferredContinuationBackgroundStatus =
  | { state: 'disabled' }
  | { state: 'enabled'; executablePath: string }
  | { state: 'needs_repair'; executablePath?: string }

export async function getDeferredContinuationBackgroundStatus(
  plistPath = getDeferredContinuationLaunchAgentPath(),
): Promise<DeferredContinuationBackgroundStatus> {
  let contents: string
  try {
    const info = await lstat(plistPath)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      return { state: 'needs_repair' }
    }
    contents = await readFile(plistPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'disabled' }
    return { state: 'needs_repair' }
  }
  const match = contents.match(
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>\s*<string>deferred-continuation-worker<\/string>/,
  )
  const executablePath = match?.[1] ? unescapeXml(match[1]) : undefined
  if (
    !executablePath ||
    !isAbsolute(executablePath) ||
    executablePath.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(executablePath)
  ) {
    return { state: 'needs_repair' }
  }
  try {
    const canonical = await validateStableDeferredContinuationExecutable(executablePath)
    return { state: 'enabled', executablePath: canonical }
  } catch {
    return { state: 'needs_repair', executablePath }
  }
}

export async function installDeferredContinuationLaunchAgent(
  executablePath: string,
  plistPath = getDeferredContinuationLaunchAgentPath(),
  run: LaunchctlExecutor = defaultLaunchctlExecutor,
): Promise<string> {
  const canonical = await validateStableDeferredContinuationExecutable(executablePath)
  await writeLaunchAgentAtomically(
    plistPath,
    renderDeferredContinuationLaunchAgent(canonical),
  )
  // First install has no loaded job; bootstrap below is authoritative.
  await run(['bootout', `gui/${process.getuid!()}`, plistPath])
  const bootstrapped = await run([
    'bootstrap',
    `gui/${process.getuid!()}`,
    plistPath,
  ])
  if (bootstrapped.outcome !== 'ok') {
    await unlink(plistPath).catch(() => {})
    await syncDirectory(dirname(plistPath)).catch(() => {})
    throw new Error(
      `Background continuation could not be enabled: launchctl bootstrap failed for ${plistPath}.`,
    )
  }
  return canonical
}

export async function uninstallDeferredContinuationLaunchAgent(
  plistPath = getDeferredContinuationLaunchAgentPath(),
  run: LaunchctlExecutor = defaultLaunchctlExecutor,
): Promise<boolean> {
  try {
    await lstat(plistPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A missing plist is NOT proof the job is gone. launchd keeps a loaded job
    // in the domain after its plist is deleted — by hand, or by an install that
    // failed after bootstrap — until bootout or logout. Returning false here
    // reports "already disabled" while the timer keeps firing unattended turns:
    // the same false success the load-state check below exists to prevent.
    const orphan = await getDeferredContinuationLoadState(run)
    if (orphan === 'not_loaded') return false
    // Boot out by label — there is no plist path left to name.
    await run([
      'bootout',
      `gui/${process.getuid!()}/${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}`,
    ])
    if ((await getDeferredContinuationLoadState(run)) === 'not_loaded') return true
    throw new Error(
      `Background continuation could not be disabled: the launchd job ${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL} is loaded but ${plistPath} is missing, so it could not be unloaded from its plist. Unload it with: launchctl bootout gui/$(id -u)/${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}`,
    )
  }
  await run(['bootout', `gui/${process.getuid!()}`, plistPath])
  // bootout's status is ambiguous, so the job's own load state decides. Keep the
  // plist unless the job is confirmed gone: deleting it while the job is still
  // loaded would leave the timer running with no on-disk record to repair from,
  // and report that as a successful disable.
  const state = await getDeferredContinuationLoadState(run)
  if (state !== 'not_loaded') {
    throw new Error(
      state === 'loaded'
        ? `Background continuation could not be disabled: the launchd job ${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL} is still loaded. ${plistPath} was kept so it stays repairable. Unload it with: launchctl bootout gui/$(id -u) ${plistPath}`
        : `Background continuation could not be disabled: unable to verify whether the launchd job ${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL} is still loaded. ${plistPath} was kept so it stays repairable.`,
    )
  }
  await unlink(plistPath)
  await syncDirectory(dirname(plistPath))
  return true
}
