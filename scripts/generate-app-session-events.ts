import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync('src/app-runtime/sessionEvents.ts', 'utf8')
const contract = readFileSync('src/app-runtime/toolActivityContract.ts', 'utf8')
const reviewContract = readFileSync('src/app-runtime/autoModeReviewContract.ts', 'utf8')
const names = source.match(/export type AppSessionEvent =([\s\S]*?)\n\n/)![1]!.match(/\w+/g)!
const declarations = names.map(name => {
  const owner = name === 'ToolActivity' ? contract : name === 'AutoModeReview' ? reviewContract : source
  const declaration = owner.match(new RegExp(`export type ${name} = \\{[\\s\\S]*?\\n\\}`))?.[0]
  if (!declaration) throw new Error(`Missing event source: ${name}`)
  return declaration.replace(`export type ${name} = `, '')
})
const path = 'app/shared/engine-types.snapshot.d.ts'
const questionSource = ts.createSourceFile('pendingQuestions.ts', readFileSync('src/utils/pendingQuestions.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const questionNames = new Set(['QuestionReference', 'PendingQuestionSpec', 'PendingQuestion', 'ResolvedQuestion', 'ResolvedQuestionSnapshot', 'QuestionSnapshot'])
const questionTypes = questionSource.statements.filter(node => ts.isTypeAliasDeclaration(node) && questionNames.has(node.name.text)).map(node => node.getText(questionSource)).join('\n\n')
const snapshot = readFileSync(path, 'utf8').replace(/\/\* --- generated question lifecycle --- \*\/[\s\S]*?\/\* --- end question lifecycle --- \*\/\n\n/g, '').replace(/export type AppSessionEvent =[\s\S]*?(?=\/\* --- src\/app-runtime\/appSessionProtocol)/,
  `/* --- generated question lifecycle --- */\n${questionTypes}\n/* --- end question lifecycle --- */\n\nexport type AppSessionEvent =\n${declarations.map(value => value.split('\n').map((line, index) => index === 0 ? `  | ${line}` : `    ${line}`).join('\n')).join('\n')}\n\n`)
writeFileSync(path, snapshot)
