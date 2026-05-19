import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import ts from 'typescript'
import { fileURLToPath } from 'url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceExtensions = new Set(['.ts', '.tsx'])

type SourceArea = {
  label: string
  dir: string
  allowReact: boolean
}

const sourceAreas: SourceArea[] = [
  {
    label: 'app runtime boundary',
    dir: join(repoRoot, 'src', 'app-runtime'),
    allowReact: false,
  },
  {
    label: 'dedicated app shell',
    dir: join(repoRoot, 'src', 'dedicated-app'),
    allowReact: true,
  },
]

const baseForbiddenImports = [
  {
    reason: 'terminal dependency',
    test: (specifier: string) => specifier === 'ink' || specifier.startsWith('ink/'),
  },
  {
    reason: 'screen import',
    test: (specifier: string) => /(^|\/)screens(\/|$)/.test(specifier),
  },
  {
    reason: 'terminal component import',
    test: (specifier: string) => /(^|\/)components(\/|$)/.test(specifier),
  },
  {
    reason: 'web import',
    test: (specifier: string) => /(^|\/)web(\/|$)/.test(specifier),
  },
] as const

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath))
      continue
    }

    const extension = entry.name.slice(entry.name.lastIndexOf('.'))
    if (sourceExtensions.has(extension)) {
      files.push(fullPath)
    }
  }

  return files
}

function getImportSpecifiers(filePath: string): Array<{
  specifier: string
  position: number
}> {
  const source = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specifiers: Array<{ specifier: string; position: number }> = []

  function addSpecifier(node: ts.StringLiteralLike): void {
    specifiers.push({ specifier: node.text, position: node.getStart(sourceFile) })
  }

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addSpecifier(node.moduleSpecifier)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addSpecifier(node.moduleSpecifier)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      addSpecifier(node.arguments[0])
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      addSpecifier(node.arguments[0])
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function createSourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

const violations: string[] = []
let checkedFileCount = 0

for (const area of sourceAreas) {
  if (!existsSync(area.dir)) {
    console.error(`${area.label} source not found at ${relative(repoRoot, area.dir)}`)
    process.exit(1)
  }

  const sourceFiles = collectSourceFiles(area.dir)

  if (sourceFiles.length === 0) {
    console.error(`No TypeScript source files found under ${relative(repoRoot, area.dir)}`)
    process.exit(1)
  }

  checkedFileCount += sourceFiles.length

  for (const filePath of sourceFiles) {
    const sourceFile = createSourceFile(filePath)

    for (const { specifier, position } of getImportSpecifiers(filePath)) {
      const rules = area.allowReact
        ? baseForbiddenImports
        : [
            ...baseForbiddenImports,
            {
              reason: 'React import in runtime boundary',
              test: (value: string) =>
                value === 'react' || value.startsWith('react/'),
            },
          ]

      for (const rule of rules) {
        if (rule.test(specifier)) {
          const { line, character } =
            sourceFile.getLineAndCharacterOfPosition(position)
          violations.push(
            `${relative(repoRoot, filePath)}:${line + 1}:${character + 1} imports ${JSON.stringify(specifier)} (${rule.reason})`,
          )
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Dedicated app validation failed:')
  for (const violation of violations) {
    console.error(`- ${violation}`)
  }
  process.exit(1)
}

console.log(`Dedicated app validation passed (${checkedFileCount} files checked)`)
