import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'node:stream'
import { render, useApp } from '../../../ink.js'
import { AppStoreContext } from '../../../state/AppState.js'
import { getDefaultAppState } from '../../../state/AppStateStore.js'
import { createStore } from '../../../state/store.js'
import { TerminalSizeContext } from '../../../ink/components/TerminalSizeContext.js'
import { QuestionView } from './QuestionView.js'
import { Select } from '../../CustomSelect/index.js'

function ExitAfterRender({ children }: { children: React.ReactNode }) {
  const { exit } = useApp()
  React.useLayoutEffect(() => {
    const timer = setTimeout(exit, 0)
    return () => clearTimeout(timer)
  }, [exit])
  return children
}

async function renderQuestion(node: React.ReactNode): Promise<string> {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const instance = await render(<ExitAfterRender>{node}</ExitAfterRender>, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  await instance.waitUntilExit()
  return output
}

for (const multiSelect of [false, true]) {
  test(`zero options renders a free-text input (multiSelect=${multiSelect})`, async () => {
    const question = { question: 'What do you need?', header: 'Details', options: [], multiSelect }
    const questionStates = { [question.question]: { textInputValue: '' } }
    const onAnswer = mock(() => {})
    let selectProps: React.ComponentProps<typeof Select> | undefined
    function inspect(node: React.ReactNode): void {
      React.Children.forEach(node, child => {
        if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return
        if (child.type === Select) selectProps = child.props as React.ComponentProps<typeof Select>
        inspect(child.props.children)
      })
    }
    function InspectQuestion() {
      const node = QuestionView({
        question, questions: [question], currentQuestionIndex: 0,
        answers: {}, questionStates, onUpdateQuestionState() {},
        onAnswer, onTextInputFocus() {}, onCancel() {},
        onSubmit() {}, onRespondToClaude() {}, onFinishPlanInterview() {},
      })
      inspect(node)
      return node
    }
    const output = await renderQuestion(
      <AppStoreContext.Provider value={createStore(getDefaultAppState())}>
        <TerminalSizeContext.Provider value={{ columns: 100, rows: 40 }}>
          <InspectQuestion />
        </TerminalSizeContext.Provider>
      </AppStoreContext.Provider>,
    )
    expect(output).toContain('What do you need?')
    expect(output).toContain('Type something')
    expect(output).not.toContain('Other')
    expect(selectProps).toBeDefined()
    expect(selectProps!.options[0]).toMatchObject({ type: 'input', label: 'Answer' })
    questionStates[question.question]!.textInputValue = '   '
    selectProps!.onChange!('__other__')
    expect(onAnswer).not.toHaveBeenCalled()
    questionStates[question.question]!.textInputValue = 'Wait, explain first.'
    selectProps!.onChange!('__other__')
    expect(onAnswer).toHaveBeenCalledWith(question.question, '__other__', 'Wait, explain first.')
  })
}
