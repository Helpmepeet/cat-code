import { expect, spyOn } from 'bun:test'

await (await import('./workerRuntime.js')).bootstrapWorkerEngine()
const { createOwnedCommandBudget } = await import('../../src/utils/ownedCommandBudget.js')
const exec = await import('../../src/utils/execFileNoThrow.js')
const bundled = await import('../../src/utils/bundledMode.js')
const local = await import('../../src/utils/localInstaller.js')
const platform = await import('../../src/utils/platform.js')
const managers = await import('../../src/utils/nativeInstaller/packageManagers.js')
const { env } = await import('../../src/utils/env.js')
const doctor = await import('../../src/utils/doctorDiagnostic.js')
const { checkInstall } = await import('../../src/utils/nativeInstaller/installer.js')
const { checkGlobalInstallPermissions } = await import('../../src/utils/autoUpdater.js')

process.env.NODE_ENV = 'production'
process.argv[1] = '/isolated/invocation'
spyOn(bundled, 'isInBundledMode').mockReturnValue(false)
spyOn(local, 'isRunningFromLocalInstallation').mockReturnValue(false)
const calls: string[] = []
const budget = createOwnedCommandBudget(2000)
function record(file: string, options: ReturnType<typeof budget.commandOptions> | undefined) {
  expect(options?.abortSignal).toBe(budget.signal)
  expect(options?.timeout).toBeGreaterThan(0)
  expect(options?.timeout).toBeLessThanOrEqual(2000)
  expect(options?.killProcessGroupOnTimeout).toBe(true)
  expect(options?.killProcessGroupOnAbort).toBe(true)
  calls.push(file)
  return Promise.resolve({ code: 0, stdout: process.cwd(), stderr: '' })
}
spyOn(exec, 'execFileNoThrow').mockImplementation((file, _args, options) => record(file, options as ReturnType<typeof budget.commandOptions>))
spyOn(exec, 'execFileNoThrowWithCwd').mockImplementation((file, _args, options) => record(file, options as ReturnType<typeof budget.commandOptions>))
try {
  await checkInstall(false, budget)
  await doctor.getDoctorDiagnostic(budget)
  expect(calls).toEqual(['npm', 'npm', 'npm'])
  process.argv[1] = '/usr/local/bin/cat-code'
  spyOn(env, 'isRunningWithBun').mockReturnValue(false)
  await doctor.getDoctorDiagnostic(budget)
  expect(calls.slice(-2)).toEqual(['npm', 'npm'])
  for (const bun of [false, true]) {
    spyOn(env, 'isRunningWithBun').mockReturnValue(bun)
    await checkGlobalInstallPermissions(budget)
    expect(calls.at(-1)).toBe(bun ? 'bun' : 'npm')
  }
  spyOn(platform, 'getPlatform').mockReturnValue('linux')
  spyOn(managers, 'getOsRelease').mockResolvedValue(null)
  await managers.detectPacman(budget)
  await managers.detectDeb(budget)
  await managers.detectRpm(budget)
  await managers.detectApk(budget)
  expect(calls.slice(-4)).toEqual(['pacman', 'dpkg', 'rpm', 'apk'])
  spyOn(exec, 'execFileNoThrow').mockResolvedValue({
    code: 1, stdout: '', stderr: '', error: 'Command failed with exit code 1',
  })
  for (const detect of [managers.detectPacman, managers.detectDeb, managers.detectRpm, managers.detectApk]) {
    detect.cache.clear?.()
    expect(await detect(budget)).toBe(false)
  }
  budget.dispose()
  await expect(doctor.getCurrentInstallationType(budget)).rejects.toThrow('cancelled or timed out')
  process.stdout.write(JSON.stringify({ calls }) + '\n')
} finally {
  budget.dispose()
}
process.exit(0)
