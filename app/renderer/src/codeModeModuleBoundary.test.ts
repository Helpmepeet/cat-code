import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('standalone email cards do not initialize the Script source parser', async () => {
  const parserImports: string[] = []
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./EmailToolResult.tsx', import.meta.url))],
    target: 'browser', format: 'esm',
    plugins: [{
      name: 'isolate-script-source-parser',
      setup(build) {
        build.onResolve({ filter: /^acorn$/ }, args => {
          parserImports.push(args.importer)
          throw new Error(`Standalone card pulled in Script parsing through ${args.importer}`)
        })
      },
    }],
  })
  expect(result.success, result.logs.join('\n')).toBe(true)
  expect(parserImports).toEqual([])
})
