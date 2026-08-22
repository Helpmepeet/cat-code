import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const schemasPath = join(repoRoot, 'src/entrypoints/sdk/coreSchemas.ts')
const generatedPath = join(repoRoot, 'src/entrypoints/sdk/coreTypes.generated.ts')
const effortSnapshotPaths = [
  generatedPath,
  join(repoRoot, 'app/shared/sdk-types.snapshot.d.ts'),
  join(repoRoot, 'scripts/typecheck/renderer-engine-types/sdk-types.snapshot.d.ts'),
]

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

const assistantErrorCodeSchemaMatch = schemas.match(
  /export const SDKAssistantErrorCodeSchema = lazySchema\(\(\) =>\s+z\.enum\(\[([\s\S]*?)\]\),\s*\)/,
)
if (!assistantErrorCodeSchemaMatch?.[1]) {
  throw new Error('Could not find SDKAssistantErrorCodeSchema enum values')
}

const assistantErrorCodes = Array.from(
  assistantErrorCodeSchemaMatch[1].matchAll(/'([^']+)'/g),
  match => match[1],
)
if (assistantErrorCodes.length === 0) {
  throw new Error('SDKAssistantErrorCodeSchema did not contain any values')
}

const assistantErrorCodeUnion = [
  'export type SDKAssistantErrorCode =',
  ...assistantErrorCodes.map(code => `  | '${code}'`),
  '',
  '',
].join('\n')

const effortLevelsMatch = schemas.match(
  /supportedEffortLevels:\s*z\s*\.array\(z\.enum\(\[([^\]]+)\]\)\)/,
)
if (!effortLevelsMatch?.[1]) {
  throw new Error('Could not find ModelInfoSchema supportedEffortLevels enum values')
}
const effortLevels = Array.from(
  effortLevelsMatch[1].matchAll(/'([^']+)'/g),
  match => match[1],
)

const nextGenerated = generated
  .replace(
    /export type SDKAccountDiagnosticCode =\n(?:  \| '[^']+'\n)+/,
    diagnosticUnion,
  )

if (nextGenerated === generated) {
  console.log('SDK types already up to date.')
} else {
  writeFileSync(generatedPath, nextGenerated, 'utf-8')
  console.log('Updated src/entrypoints/sdk/coreTypes.generated.ts.')
}

const supportedEffortLevels =
  `supportedEffortLevels?: Array<${effortLevels.map(level => `'${level}'`).join(' | ')}>`
for (const path of effortSnapshotPaths) {
  const contents = readFileSync(path, 'utf-8')
  const nextContents = contents.replace(
    /supportedEffortLevels\?: Array<[^>]+>/,
    supportedEffortLevels,
  )
  if (nextContents !== contents) {
    writeFileSync(path, nextContents, 'utf-8')
    console.log(`Updated ${path.slice(repoRoot.length + 1)}.`)
  }
}

/**
 * `agent_name` is schema-owned transcript identity on nested subagent frames.
 * Keep the generated public type and both isolated-renderer snapshots in lock
 * step with the schema source, just as supportedEffortLevels above does.
 */
const hasAgentNameSchema = /agent_name:\s*z\.string\(\)\.optional\(\)/.test(schemas)
const agentNameTypes = [
  'SDKAssistantMessage',
  'SDKUserMessage',
]

function syncAgentNameField(contents: string): string {
  const field = '  agent_name?: string\n'
  // Remove the field from every declaration it has ever targeted before adding
  // the current schema-backed set. This keeps a removed wire field from
  // lingering in generated artifacts.
  const withoutStaleFields = [
    'SDKPartialAssistantMessage',
    'SDKAssistantMessage',
    'SDKToolProgressMessage',
    'SDKUserMessage',
  ].reduce(
    (next, typeName) =>
      replaceTypeDeclaration(next, typeName, declaration => declaration.replace(field, '')),
    contents,
  )
  if (!hasAgentNameSchema) return withoutStaleFields
  return agentNameTypes.reduce(
    (next, typeName) =>
      replaceTypeDeclaration(next, typeName, declaration => {
        if (declaration.includes(field)) return declaration
        return declaration.replace(
          '  parent_tool_use_id?: string | null\n',
          `  parent_tool_use_id?: string | null\n${field}`,
        )
      }),
    withoutStaleFields,
  )
}

function replaceTypeDeclaration(
  contents: string,
  typeName: string,
  update: (declaration: string) => string,
): string {
  const start = contents.indexOf(`export type ${typeName} =`)
  if (start < 0) return contents
  const end = contents.indexOf('\n}\n\n', start)
  if (end < 0) return contents
  const declarationEnd = end + 3
  const declaration = contents.slice(start, declarationEnd)
  return `${contents.slice(0, start)}${update(declaration)}${contents.slice(declarationEnd)}`
}

function syncAssistantErrorCode(contents: string): string {
  const withoutStaleDeclaration = contents.replace(
    /export type SDKAssistantErrorCode =\n(?:  \| '[^']+'\n)+(?:\n)?/g,
    '',
  )
  const assistantMessageStart = withoutStaleDeclaration.indexOf(
    'export type SDKAssistantMessage =',
  )
  if (assistantMessageStart < 0) return withoutStaleDeclaration

  const withCodeDeclaration = `${withoutStaleDeclaration.slice(0, assistantMessageStart)}${assistantErrorCodeUnion}${withoutStaleDeclaration.slice(assistantMessageStart)}`
  const withAssistantFrameCode = replaceTypeDeclaration(
    withCodeDeclaration,
    'SDKAssistantMessage',
    declaration =>
      declaration.replace(
        '  error?: SDKAssistantMessageError\n',
        '  error?: SDKAssistantErrorCode\n',
      ),
  )
  return replaceTypeDeclaration(
    withAssistantFrameCode,
    'SDKSystemMessage',
    declaration =>
      declaration.replace(
        '  error?: SDKAssistantMessageError\n',
        '  error?: SDKAssistantErrorCode | SDKAssistantMessageError\n',
      ),
  )
}

function syncInterruptionOrigin(contents: string): string {
  const field = "  | { kind: 'interruption' }\n"
  const hasInterruptionSchema =
    /z\.object\(\{ kind: z\.literal\('interruption'\) \}\)/.test(schemas)
  const start = contents.indexOf('export type SDKMessageOrigin =')
  if (start < 0) return contents
  const end = contents.indexOf('\n\nexport type SDKUserMessage =', start)
  if (end < 0) return contents
  const declaration = contents.slice(start, end)
  const withoutField = declaration.replace(field, '')
  const nextDeclaration = hasInterruptionSchema
    ? withoutField.replace("  | { kind: 'human' }\n", `  | { kind: 'human' }\n${field}`)
    : withoutField
  return `${contents.slice(0, start)}${nextDeclaration}${contents.slice(end)}`
}

function syncToolResultStatus(contents: string): string {
  const field = "  tool_result_status?: 'cancelled'\n"
  const hasStatusSchema =
    /tool_result_status:\s*z\.literal\('cancelled'\)\.optional\(\)/.test(schemas)
  return replaceTypeDeclaration(contents, 'SDKUserMessage', declaration => {
    const withoutField = declaration.replace(field, '')
    if (!hasStatusSchema) return withoutField
    return withoutField.replace(
      '  tool_use_result?: unknown\n',
      `  tool_use_result?: unknown\n${field}`,
    )
  })
}

for (const path of effortSnapshotPaths) {
  const contents = readFileSync(path, 'utf-8')
  const nextContents = syncAgentNameField(contents)
  if (nextContents !== contents) {
    writeFileSync(path, nextContents, 'utf-8')
    console.log(`Synced subagent frame identity in ${path.slice(repoRoot.length + 1)}.`)
  }
}

for (const path of effortSnapshotPaths) {
  const contents = readFileSync(path, 'utf-8')
  const nextContents = syncAssistantErrorCode(contents)
  if (nextContents !== contents) {
    writeFileSync(path, nextContents, 'utf-8')
    console.log(`Synced assistant error codes in ${path.slice(repoRoot.length + 1)}.`)
  }
}

for (const path of effortSnapshotPaths) {
  const contents = readFileSync(path, 'utf-8')
  const nextContents = syncToolResultStatus(syncInterruptionOrigin(contents))
  if (nextContents !== contents) {
    writeFileSync(path, nextContents, 'utf-8')
    console.log(`Synced user-turn status fields in ${path.slice(repoRoot.length + 1)}.`)
  }
}
