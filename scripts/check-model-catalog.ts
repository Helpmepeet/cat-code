import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const root = join(import.meta.dir, '..')
const sourceFiles = new Bun.Glob('**/*.{ts,tsx,js,jsx,mjs,cjs}')
const releasePattern = /\bgpt[- ](?:[3-9](?:[.-]\d+)+(?:-(?:astra|sol|terra|luna|codex))?|[3-9]-(?:astra|sol|terra|luna|codex)|catalog-fixture-[\w-]+)\b|\b(?:claude[- ])?(?:opus|sonnet|haiku|fable)[- _][3456789](?:[.\-_]\d+)*\b|\bclaude-3-(?:[57]-)?(?:opus|sonnet|haiku)\b|\bgpt(?:[3-9]\d*)?(?:astra|sol|terra|luna)\d*\b|\bGPT_\d+_[A-Z_0-9]+\b/gi
const versionedKey = /^(?:sonnet|opus|haiku|fable)\d{1,3}$/i
const displayPattern = /\bGPT[- ]\d+(?:\.\d+)? (?:Astra|Sol|Terra|Luna)\b/gi

// The exact tokens in these owners are historical records, protocol examples,
// or releases that have independent qualification. Keep route defaults and
// capabilities in the catalog, including when they share one of these IDs.
const exceptions: Readonly<Record<string, readonly string[]>> = {
  // Prompt families and context policy source tags are stable.
  'src/constants/promptStyle.ts': ['gpt-5.6'],
  'src/utils/context.ts': ['gpt_5_6_codex', 'gpt_6_codex', 'claude-3-haiku', 'claude-3-opus', 'claude-3-sonnet', 'sonnet46'],
  // Independent reviewer qualifications and exact legacy compatibility.
  'src/utils/permissions/yoloClassifier.ts': ['gpt-6-luna'],
  'src/components/messages/AssistantTextMessage.tsx': ['Opus 4'],
  'src/utils/pdfUtils.ts': ['claude-3-haiku'],
  'src/utils/model/model.ts': ['claude-3-haiku', 'claude-3-opus', 'claude-3-sonnet', 'sonnet46'],
  'src/utils/model/deprecation.ts': ['claude-3-5-haiku', 'claude-3-7-sonnet', 'claude-3-opus'],
  'src/utils/extraUsage.ts': ['opus46', 'sonnet46'],
  'src/commands/model/model.tsx': ['sonnet46'],
  'src/components/EffortCallout.tsx': ['opus46'],
  'src/utils/model/modelOptions.ts': ['opus41', 'sonnet46', 'haiku35'],
  'src/utils/modelCostRates.ts': ['GPT_6_1_TERRA_CONFIG'],
  // Ordered legacy migrations and their notifications.
  'src/migrations/migrateSonnet1mToSonnet45.ts': ['sonnet-4-5-20250929'],
  'src/migrations/migrateSonnet45ToSonnet46.ts': ['claude-sonnet-4-5-20250929', 'sonnet-4-5-20250929'],
  'src/hooks/notifs/useModelMigrationNotifications.tsx': ['Opus 4.6', 'Sonnet 4.6'],
  // Public API examples, historical UI attribution, and captured test data.
  'src/entrypoints/sdk/coreSchemas.ts': ['Opus 4.6', 'claude-opus-4-5'],
  'src/schemas/hooks.ts': ['claude-sonnet-5'],
  'src/utils/settings/types.ts': ['claude-opus-4-6', 'opus-4-5'],
  'src/utils/toolSearch.ts': ['Claude Sonnet 4', 'Opus 4'],
  'src/utils/undercover.ts': ['Claude Opus 4.6', 'claude-opus-4-6', 'opus-4-7', 'sonnet-4-8'],
  'src/tools/AgentTool/built-in/statuslineSetup.ts': ['claude-3-5-sonnet'],
  'src/skills/bundled/claudeApiContent.ts': ['sonnet46'],
  'src/utils/statsCache.integration.worker.ts': ['claude-sonnet-4-5-20250929'],
  'app/scripts/visualAcceptanceFixture.ts': ['claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-5.5', 'gpt-6.1-sol'],
  'app/scripts/filePaneGuiFixture.ts': ['claude-sonnet-4-6'],
  'app/renderer/src/usageDailyChartState.ts': ['GPT 5.5'],
  'app/renderer/src/statsState.ts': ['claude-3-haiku', 'claude-3-opus'],
  'app/renderer/src/sdkMessageFixtures.ts': ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'gpt-5.6-terra'],
  'app/renderer/src/usageAnalyticsDetailsState.ts': ['GPT 5.5', 'gpt-5.5'],
}

function literalText(node: ts.Node): string | undefined {
  if (
    ts.isStringLiteralLike(node) || ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ||
    ts.isRegularExpressionLiteral(node) || ts.isIdentifier(node) || ts.isJsxText(node)
  ) return node.text
  return undefined
}

let count = 0
let failed = false
for (const directory of ['src', 'app']) {
  for (const file of sourceFiles.scanSync({ cwd: join(root, directory) })) {
    const path = `${directory}/${file}`
    if (
      /(?:^|\/)(?:node_modules|dist|out|build|coverage|\.vite)\//.test(path) ||
      /\.(?:test|spec|fixture|test-fixture|snapshot\.d)\.[cm]?[jt]sx?$/.test(path) ||
      path === 'src/utils/model/configs.ts'
    ) continue
    count++
    const source = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      const raw = literalText(node)
      const token = ts.isRegularExpressionLiteral(node) ? raw?.replace(/\\([.-])/g, '$1') : raw
      const matches = token ? [
        ...token.matchAll(releasePattern), ...token.matchAll(displayPattern),
      ].map(([match]) => match) : []
      if (token && versionedKey.test(token)) matches.push(token)
      const violations = [...new Set(matches)].filter(match => !exceptions[path]?.includes(match))
      if (violations.length) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
        console.error(`${path}:${line + 1}:${character + 1} Move release selection or capability data to the model catalog: ${violations.join(', ')}`)
        failed = true
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

if (count === 0) throw new Error('Model catalog gate found no engine or desktop source')
if (failed) process.exitCode = 1
else console.log(`Model catalog gate checked ${count} engine and desktop source files`)
