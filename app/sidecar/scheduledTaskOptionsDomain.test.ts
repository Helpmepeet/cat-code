import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the guarded effort owner isolates throwing model resolution and capabilities without losing other catalog rows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scheduled-effort-'))
  try {
    const domain = new URL('./scheduledTaskOptionsDomain.ts', import.meta.url).href
    const effort = new URL('./effortOptions.ts', import.meta.url).href
    const child = Bun.spawn([process.execPath, '-e', `
      const { buildScheduledTaskOptionsCatalog } = await import(${JSON.stringify(domain)});
      const { effortOptionsForSelection } = await import(${JSON.stringify(effort)});
      const readers = {
        getDefaultMainLoopModel: () => 'default',
        parseUserSpecifiedModel: value => { if (value === 'bad-resolution') throw Error('resolver'); return value; },
        modelSupportsEffort: model => { if (model === 'bad-capability') throw Error('capability'); return true; },
        getSupportedEffortLevels: model => { if (model === 'bad-levels') throw Error('levels'); return ['high']; },
      };
      const result = buildScheduledTaskOptionsCatalog({
        getModelOptions: () => ['good', 'bad-resolution', 'bad-capability', 'bad-levels', 'bad-provider'].map(value => ({ value, label: value })),
        effortOptionsForSelection: value => effortOptionsForSelection(value, readers),
        resolveModelSelectionProvider: value => { if (value === 'bad-provider') throw Error('provider'); return 'openai'; },
        getGlobalConfig: () => ({ projects: { '/saved': {} } }),
      });
      process.stdout.write(JSON.stringify(result));
    `], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
        NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    const result = JSON.parse(stdout)
    expect(result.models.map((model: { value: string; effortOptions: string[] }) => [model.value, model.effortOptions])).toEqual([
      ['good', ['high']], ['bad-resolution', []], ['bad-capability', []], ['bad-levels', []],
    ])
    expect(result.defaultEffortOptions).toEqual(['high'])
    expect(result.projectPaths).toEqual(['/saved'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
