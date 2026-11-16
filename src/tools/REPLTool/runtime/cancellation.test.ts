import { test, expect } from 'bun:test'

// A subprocess isolates process.cpuUsage from concurrently executing test files.
// The guest's output proves evaluation reached the loop before cancellation.
test('armed synchronous guest cancellation stops worker CPU consumption', async () => {
  const runtimeUrl = new URL('./index.ts', import.meta.url).href
  const source = `
    import { createRuntime } from ${JSON.stringify(runtimeUrl)};
    const guard = setTimeout(() => process.exit(90), 4000);
    const runtime = createRuntime({ limits: { wallTimeMs: 3000 } });
    const controller = new AbortController();
    let armed = false;
    try {
      const outcome = await runtime.run({
        cellId: 'sync-cancellation',
        source: 'output("armed"); while(true){}',
        signal: controller.signal,
        dispatch: async () => { throw new Error('No tool dispatch expected'); },
        onOutput(output) {
          if (output.value === 'armed' && !armed) {
            armed = true;
            setTimeout(() => controller.abort(), 25);
          }
        },
      });
      if (!armed || outcome.status !== 'cancelled') {
        throw new Error(JSON.stringify({ armed, outcome }));
      }
      const start = process.cpuUsage();
      await new Promise(resolve => setTimeout(resolve, 500));
      const usage = process.cpuUsage(start);
      const cpuMs = (usage.user + usage.system) / 1000;
      console.log(JSON.stringify({ armed, status: outcome.status, cpuMs }));
      // A surviving busy worker consumes roughly 500ms of CPU in this window.
      // Allow substantial cleanup overhead without depending on timer precision.
      if (cpuMs >= 250) throw new Error('Cancelled worker still consumes CPU: ' + cpuMs);
    } finally {
      runtime.dispose();
      clearTimeout(guard);
    }
  `
  const child = Bun.spawn([process.execPath, '--eval', source], {
    stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin' },
  })
  let timedOut = false
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 6000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(timedOut, 'Cancellation probe exceeded its external deadline').toBe(false)
    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout.trim())
    expect(result.armed).toBe(true)
    expect(result.status).toBe('cancelled')
    expect(result.cpuMs).toBeLessThan(250)
    console.log(`Post-cancellation isolated CPU over 500ms: ${result.cpuMs.toFixed(3)}ms`)
  } finally {
    clearTimeout(guard)
    child.kill('SIGKILL')
    await child.exited
  }
}, 10_000)
