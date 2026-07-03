import { expect, test } from 'bun:test'

test('normal sidecar bootstrap enables config reads before the first turn', async () => {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `
        import { initializeSidecarRuntime } from './app/sidecar/initializeRuntime.ts'
        import { getGlobalConfig } from './src/utils/config.ts'
        await initializeSidecarRuntime()
        getGlobalConfig()
        if (typeof MACRO === 'undefined') {
          process.stderr.write('MACRO is not initialized')
          process.exit(1)
        }
        process.stdout.write('runtime-ready')
        process.exit(0)
      `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'development' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(exitCode).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).toBe('runtime-ready')
})
