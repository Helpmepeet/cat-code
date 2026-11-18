import { parse } from 'acorn'

// Every native async assimilation point must adopt through a tracked promise.
// Dynamic compilation and implicit async iteration are disabled in this profile.
function instrument(source: string): string {
  const ast = parse(source, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true })
  const inserts = new Map<number, string[]>()
  function add(at: number, text: string) { inserts.set(at, [...(inserts.get(at) ?? []), text]) }
  function walk(value: unknown, asyncBody = false): void {
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, any>
    if (node.type === 'WithStatement') throw new Error('Dynamic scope is not supported by the continuation-fenced runtime')
    if (node.type === 'Identifier' && (node.name.startsWith('__cm') || node.name === '__cellBindings')) throw new Error('Reserved runtime identifier')
    if ((node.type === 'ForOfStatement' && node.await) || (node.async && node.generator)) throw new Error('Async iteration is not supported by the continuation-fenced runtime')
    const isFunction = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
    const inAsync = isFunction ? Boolean(node.async) : asyncBody
    const expression = node.type === 'AwaitExpression' ? node.argument
      : node.type === 'ReturnStatement' && inAsync ? node.argument
        : node.type === 'ArrowFunctionExpression' && node.async && node.body.type !== 'BlockStatement' ? node.body : undefined
    if (expression) { add(expression.start, '__cmAdopt(('); add(expression.end, '))') }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue
      if (Array.isArray(child)) child.forEach(item => walk(item, inAsync))
      else if (child && typeof child === 'object') walk(child, inAsync)
    }
  }
  walk(ast)
  for (const [at, texts] of [...inserts].sort((a, b) => b[0] - a[0])) source = source.slice(0, at) + texts.join('') + source.slice(at)
  return source
}

// Notebook declarations deliberately live on the global object. Nested lexical scopes
// remain ordinary JavaScript. Replacements preserve newlines for guest stack traces.
// Top-level let/const are mutable notebook bindings, not native lexical declarations.
// Bridge objects carry no admission. Only the drained runtime generation has an
// active host owner; unresolved continuations prevent another cell's admission.
// No guest program is replayed.
export function transform(source: string): string {
  source = instrument(source)
  const ast = parse(source, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true })
  const edits: { start: number; end: number; text: string }[] = []
  const hoisted = new Map<string, string>()
  let directiveEnd = 0
  for (const node of ast.body) {
    if (node.type === 'ExpressionStatement' && node.directive !== undefined) {
      directiveEnd = node.end
    } else if (node.type === 'VariableDeclaration') {
      const text = source.slice(node.start, node.declarations[0]!.start).replace(/\S/g, ' ') + node.declarations.map((d, index) => {
        const expression = source.slice(d.start, d.end) + (d.init ? '' : ' = undefined')
        const next = node.declarations[index + 1]
        const separator = source.slice(d.end, next?.start ?? node.end)
        return `(${expression})${separator}`
      }).join('') + (source[node.end - 1] === ';' ? '' : ';')
      edits.push({ start: node.start, end: node.end, text })
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      // Native hoisting makes the factory callable at entry while keeping the
      // named function body on its original lines and its binding in the notebook.
      const factory = `__cmFunction${edits.length}`
      hoisted.set(node.id.name, factory)
      edits.push({ start: node.start, end: node.end, text: `function ${factory}(){return ${source.slice(node.start, node.end)};}` })
    } else if (node.type === 'ClassDeclaration' && node.id) {
      edits.push({ start: node.start, end: node.end, text: `globalThis[${JSON.stringify(node.id.name)}] = ${source.slice(node.start, node.end)};` })
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  const declarations = [...hoisted].map(([name, factory]) => `globalThis[${JSON.stringify(name)}]=${factory}();`).join('')
  if (declarations) source = source.slice(0, directiveEnd) + ';' + declarations + source.slice(directiveEnd)
  return `(async function({tools,output,console}){${source}\n})(__cellBindings())`
}
