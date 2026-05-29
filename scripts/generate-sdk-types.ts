import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const schemasPath = join(repoRoot, 'src/entrypoints/sdk/coreSchemas.ts')
const generatedPath = join(repoRoot, 'src/entrypoints/sdk/coreTypes.generated.ts')

const schemas = readFileSync(schemasPath, 'utf-8')
const generated = readFileSync(generatedPath, 'utf-8')

const diagnosticSchemaMatch = schemas.match(
  /export const SDKAccountDiagnosticCodeSchema = lazySchema\(\(\) =>\s+z\.enum\(\[([\s\S]*?)\]\),\s*\)/,
)
if (!diagnosticSchemaMatch?.[1]) {
  throw new Error('Could not find SDKAccountDiagnosticCodeSchema enum values')
}

const diagnosticCodes = Array.from(
  diagnosticSchemaMatch[1].matchAll(/'([^']+)'/g),
  match => match[1],
)
if (diagnosticCodes.length === 0) {
  throw new Error('SDKAccountDiagnosticCodeSchema did not contain any values')
}

const diagnosticUnion = [
  'export type SDKAccountDiagnosticCode =',
  ...diagnosticCodes.map(code => `  | '${code}'`),
  '',
].join('\n')

const nextGenerated = generated.replace(
  /export type SDKAccountDiagnosticCode =\n(?:  \| '[^']+'\n)+/,
  diagnosticUnion,
)

if (nextGenerated === generated) {
  console.log('SDK types already up to date.')
} else {
  writeFileSync(generatedPath, nextGenerated, 'utf-8')
  console.log('Updated src/entrypoints/sdk/coreTypes.generated.ts.')
}
