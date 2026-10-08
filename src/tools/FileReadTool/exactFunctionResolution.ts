import * as path from 'path'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
])

export function isFunctionResolutionSource(filePath: string): boolean {
  return (
    SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) &&
    !/\.d\.(?:ts|mts|cts)$/i.test(filePath)
  )
}

export function exactFunctionName(filePath: string): string | undefined {
  if (!isFunctionResolutionSource(filePath)) return undefined
  const name = path.basename(filePath, path.extname(filePath))
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : undefined
}

export type ExactFunctionDefinition = {
  content: string
  startLine: number
  endLine: number
}

function isFunctionValue(node: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return isFunctionValue(node.expression)
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false
  const callee = node.expression
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'React'
      ? callee.name.text
      : undefined
  return (
    (name === 'memo' || name === 'forwardRef') &&
    isFunctionValue(node.arguments[0]!)
  )
}

export function findExactFunctionDefinitions(
  filePath: string,
  content: string,
  symbol: string,
): ExactFunctionDefinition[] {
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  )
  // Recovery must not treat the parser's synthesized/incomplete nodes as code.
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics.length > 0
  ) return []

  const matches: ExactFunctionDefinition[] = []
  function visit(node: ts.Node): void {
    const declaration =
      ts.isFunctionDeclaration(node) && node.name?.text === symbol && node.body
        ? node
        : ts.isVariableStatement(node) &&
            node.declarationList.declarations.length === 1 &&
            node.declarationList.declarations.some(
              binding =>
                ts.isIdentifier(binding.name) &&
                binding.name.text === symbol &&
                binding.initializer !== undefined &&
                isFunctionValue(binding.initializer),
            )
          ? node
          : undefined
    if (declaration) {
      const start = declaration.getStart(source)
      const end = declaration.getEnd()
      const lineStart = content.lastIndexOf('\n', start - 1) + 1
      const nextNewline = content.indexOf('\n', end)
      const lineEnd = nextNewline === -1 ? content.length : nextNewline
      // Do not return unrelated code that shares the declaration's boundary lines.
      if (
        content.slice(lineStart, start).trim() === '' &&
        content.slice(end, lineEnd).trim() === ''
      ) {
        matches.push({
          content: content.slice(lineStart, end),
          startLine: source.getLineAndCharacterOfPosition(start).line + 1,
          endLine: source.getLineAndCharacterOfPosition(end - 1).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return matches
}
