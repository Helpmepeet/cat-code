import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '..')
const viteReactPreambleHash =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"

test('allows only the hashed Vite React preamble in both renderer CSP layers', () => {
  const mainSource = readFileSync(join(appRoot, 'main', 'main.ts'), 'utf8')
  const rendererHtml = readFileSync(
    join(appRoot, 'renderer', 'index.html'),
    'utf8',
  )

  expect(mainSource).toContain(viteReactPreambleHash)
  expect(rendererHtml).toContain(viteReactPreambleHash)

  const scriptPolicies = [mainSource, rendererHtml].flatMap(source =>
    source.match(/script-src[^;"\n]*/g) ?? [],
  )
  expect(scriptPolicies.length).toBeGreaterThanOrEqual(2)
  for (const policy of scriptPolicies) {
    expect(policy).not.toContain("'unsafe-inline'")
  }
})
