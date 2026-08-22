import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * Assertions about what the code DOES must not read the comments explaining why
 * it does it. The driver's own header names `showInactive()` in order to rule it
 * out, and a naive substring check reads that as the call it forbids.
 */
function code(url: URL): string {
  return readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * The load-bearing property of this harness is NOT that it takes a picture. It is
 * that taking the picture never raises a window over whatever the operator is
 * doing: agent-driven GUI checking was banned here after repeated cursor warps
 * forced a machine restart (`docs/migration/process/GUI-VERIFICATION.md`).
 *
 * That property lives in two places, so both are pinned here: main must skip its
 * `show()` under the capture flag, and the driver must refuse to photograph a
 * window that turned out visible anyway.
 */
test('the capture run never shows the window', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8')

  // The gate itself, and the fact that ONLY the show is gated: readiness and the
  // post-paint scheduling below it must still run, or a capture photographs a
  // shell that never finished starting.
  expect(main).toContain("if (process.env.CATCODE_HEADLESS_CAPTURE !== '1') {\n      window.show()\n    }")
  expect(main.match(/window\.show\(\)/g) ?? []).toHaveLength(1)
  expect(main).toContain("logOperational('renderer.load.ready', 'info')")

  const driver = code(new URL('./visual-acceptance-driver.ts', import.meta.url))
  // Fail rather than quietly photograph a raised window: a silent capture here
  // would mean the gate regressed and nobody noticed.
  expect(driver).toContain('if (window.isVisible())')
  expect(driver).toContain('the capture-run show gate did not hold')
  // Neither way of putting a window on screen may appear in the driver's CODE.
  expect(driver).not.toContain('.show()')
  expect(driver).not.toContain('showInactive')
})

test('the capture run drives an isolated state directory, never the operator real one', () => {
  const source = readFileSync(new URL('./visual-acceptance.ts', import.meta.url), 'utf8')

  expect(source).toContain("mkdtempSync(join(tmpdir(), 'catcode-visual-config-'))")
  expect(source).toContain("mkdtempSync(join(tmpdir(), 'catcode-visual-cwd-'))")
  expect(source).toContain('CLAUDE_CONFIG_DIR: configHome')
  expect(source).toContain("CATCODE_HEADLESS_CAPTURE: '1'")
})

test('capture cleanup is reachable on every exit path', () => {
  const source = readFileSync(new URL('./visual-acceptance.ts', import.meta.url), 'utf8')

  expect(source).toContain('async function cleanup(): Promise<void>')
  expect(source).toContain('await cleanup()')
  expect(source).toContain('await main()\nprocess.exit(process.exitCode ?? 0)')
  expect(source.match(/\bprocess\.exit\(/g) ?? []).toHaveLength(1)
  expect(source).toContain('...(vite ? [terminateChild(vite)] : [])')
  expect(source).toContain('...(electron ? [terminateChild(electron)] : [])')
  // The temp dirs are the harness's own; leaving them behind on a failed run
  // fills /tmp across a long day of runs.
  expect(source).toContain('rmSync(dir, { recursive: true, force: true })')
})

test('a blank frame fails the run instead of being written', () => {
  const driver = code(new URL('./visual-acceptance-driver.ts', import.meta.url))

  // An empty NativeImage written to disk is the failure mode that makes a whole
  // contact sheet worthless while every run still reports success.
  expect(driver).toContain('if (image.isEmpty())')
  expect(driver).toContain('capture produced no pixels')
  // Animations and the caret are why a screenshot differs from itself; frozen
  // once before the first frame, not per capture.
  expect(driver).toContain('animation:none!important')
  expect(driver).toContain('caret-color:transparent!important')
})
