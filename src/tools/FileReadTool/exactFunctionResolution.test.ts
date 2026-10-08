import { describe, expect, test } from 'bun:test'
import {
  exactFunctionName,
  findExactFunctionDefinitions,
} from './exactFunctionResolution.js'

describe('exact local function syntax', () => {
  test('derives only a literal identifier basename for supported source files', () => {
    expect(exactFunctionName('/src/TasksStrip.tsx')).toBe('TasksStrip')
    expect(exactFunctionName('/src/modelCallRecorder.ts')).toBe('modelCallRecorder')
    for (const file of ['TasksStrip.test.tsx', 'tasks-strip.ts', 'TasksStrip.py', 'TasksStrip.d.ts']) {
      expect(exactFunctionName(file)).toBeUndefined()
    }
  })

  test.each([
    'export function TasksStrip() {\n  return <div />\n}',
    'export default async function TasksStrip() {\n  return <div />\n}',
    'const TasksStrip: React.FC = () => <div />;',
    'export const TasksStrip = function () {\n  return <div />\n};',
    'const TasksStrip = React.memo(React.forwardRef(() => <div />));',
    'const TasksStrip = memo(() => {\n  return <div />\n});',
  ])('extracts a complete declaration or function binding: %s', definition => {
    const content = `// before\n${definition}\nconst unrelated = 42;\n`
    expect(findExactFunctionDefinitions('App.tsx', content, 'TasksStrip')).toEqual([
      {
        content: definition,
        startLine: 2,
        endLine: definition.split('\n').length + 1,
      },
    ])
  })

  test.each([
    'function TasksStripExtra() {}',
    'function createTasksStrip() {}',
    'const TasksStrip = otherFunction;',
    'const TasksStrip = wrap(() => 42);',
    'const TasksStrip = memo(() => 42, compare);',
    'const TasksStrip = () => 42, unrelated = 1;',
    'declare function TasksStrip(): void;',
    'class TasksStrip {}',
    'const object = { TasksStrip() {} };',
    '// function TasksStrip() {}',
    'const text = "function TasksStrip() {}";',
    'function TasksStrip() {',
    'function TasksStrip() {} const unrelated = 42;',
  ])('does not resolve unsupported, incomplete, or inexact code: %s', content => {
    expect(findExactFunctionDefinitions('App.tsx', content, 'TasksStrip')).toEqual([])
  })

  test('counts duplicate exact definitions rather than picking the first', () => {
    const content = 'function TasksStrip() {}\n{\n  const TasksStrip = () => 42;\n}'
    expect(findExactFunctionDefinitions('App.tsx', content, 'TasksStrip')).toHaveLength(2)
  })
})
