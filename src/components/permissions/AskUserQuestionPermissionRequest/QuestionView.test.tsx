import { feature } from 'bun:bundle'
import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'node:stream'
import { render, useApp } from '../../../ink.js'
import { AppStoreContext } from '../../../state/AppState.js'
import { getDefaultAppState } from '../../../state/AppStateStore.js'
import { createStore } from '../../../state/store.js'
import { TerminalSizeContext } from '../../../ink/components/TerminalSizeContext.js'
import { QuestionView } from './QuestionView.js'
import { Select, SelectMulti } from '../../CustomSelect/index.js'
import { useMultiSelectState } from '../../CustomSelect/use-multi-select-state.js'
import { AskUserQuestionPermissionRequest } from './AskUserQuestionPermissionRequest.js'
import { SubmitQuestionsView } from './SubmitQuestionsView.js'
import { takeQuestionSelections } from '../../../utils/questionSelections.js'
import { AskUserQuestionTool } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'

// The registry path never mounts the blocking permission dialog.
const blockingTest = feature('NONBLOCKING_ASK_USER_QUESTION') ? test.skip : test

function findElement(node: React.ReactNode, type: unknown): React.ReactElement<any> | undefined {
  let found: React.ReactElement<any> | undefined
  React.Children.forEach(node, child => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return
    if (child.type === type) found = child
    else found ??= findElement(child.props.children, type)
  })
  return found
}

async function driveQuestion(node: React.ReactNode, act: () => Promise<void>) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  stdout.resume()
  const state = getDefaultAppState()
  state.settings = { ...state.settings, syntaxHighlightingDisabled: true }
  const instance = await render(
    <AppStoreContext.Provider value={createStore(state)}>
      <TerminalSizeContext.Provider value={{ columns: 100, rows: 40 }}>
        {node}
      </TerminalSizeContext.Provider>
    </AppStoreContext.Provider>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false },
  )
  try { await act() } finally { instance.unmount() }
}

const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)) }

for (const text of ['No', 'N']) {
  for (const selected of [[], ['A, B']]) {
    blockingTest(`typing ${text} then submitting preserves current Other text (${selected.length} options)`, async () => {
      const question = { question: 'Choose?', header: 'Choice', multiSelect: true, options: [
        { label: 'A, B', description: 'One option' },
        { label: 'C', description: 'Another option' },
      ] }
      let selection: ReturnType<typeof useMultiSelectState<string>>
      let submitTypedAnswer: () => void
      let selectOption: (values: string[]) => void
      let finalResponse: (value: string) => void
      const onAllow = mock((input: any) => {})
      const toolUseID = `terminal-typed-${text}-${selected.length}`
      function TypingQuestion(questionProps: any) {
        const node = QuestionView(questionProps)
        const props = findElement(node, SelectMulti)!.props
        submitTypedAnswer = props.onSubmit
        selectOption = props.onChange
        selection = useMultiSelectState({ ...props, defaultValue: selected, onCancel() {} })
        return node
      }
      function Harness() {
        const wrapper = AskUserQuestionPermissionRequest({
          toolUseConfirm: { input: { questions: [question] }, toolUseID, permissionResult: { behavior: 'ask', message: '' }, onAllow, onReject() {} },
          onDone() {}, onReject() {},
        })
        const node = (wrapper.type as Function)(wrapper.props)
        const view = findElement(node, QuestionView)
        const submit = findElement(node, SubmitQuestionsView)
        if (submit) finalResponse = submit.props.onFinalResponse
        return view ? <TypingQuestion {...view.props} /> : node
      }
      await driveQuestion(<Harness />, async () => {
        if (selected.length) {
          selectOption!(selected)
          await flush()
        }
        for (let i = 1; i <= text.length; i++) {
          selection!.updateInputValue('__other__', text.slice(0, i))
          await flush()
        }
        // Submit without toggling any option after typing.
        submitTypedAnswer!()
        await flush()
        finalResponse!('submit')
        await flush()
        expect(onAllow).toHaveBeenCalledTimes(1)
        const parsed = AskUserQuestionTool.inputSchema.parse(onAllow.mock.calls[0]![0])
        expect(parsed.answers).toEqual({ [question.question]: [...selected, text].join(', ') })
        const selections = takeQuestionSelections(toolUseID, parsed.questions, parsed.answers)
        expect(selections).toHaveLength(1)
        expect(selections![0]).toMatchObject({
          other: text, notes: [],
          selectedOptions: selected.map(label => ({ optionIndex: 0, label, description: 'One option' })),
        })
      })
    })
  }
}

for (const answeredIndex of [undefined, 1]) {
blockingTest(`partial submission records only answered original question indices (${answeredIndex ?? 'empty'})`, async () => {
  const questions = [0, 1, 2].map(index => ({
    question: `Question ${index}?`, header: `Q${index}`, multiSelect: false,
    options: [{ label: 'Yes', description: 'Proceed' }, { label: 'No', description: 'Stop' }],
  }))
  const onAllow = mock((input: any) => {})
  const onDone = mock(() => {})
  let view: React.ReactElement<any>
  let submit: React.ReactElement<any> | undefined
  function Harness() {
    const wrapper = AskUserQuestionPermissionRequest({
      toolUseConfirm: { input: { questions }, toolUseID: 'terminal-partial-regression', permissionResult: { behavior: 'ask', message: '' }, onAllow, onReject() {} },
      onDone, onReject() {},
    })
    const node = (wrapper.type as Function)(wrapper.props)
    view = findElement(node, QuestionView)!
    submit = findElement(node, SubmitQuestionsView)
    return node
  }
  await driveQuestion(<Harness />, async () => {
    if (answeredIndex !== undefined) view!.props.onAnswer(questions[answeredIndex]!.question, 'No')
    await flush()
    // Navigate from the current question to the existing partial-submit view.
    for (let step = 0; !submit && step < questions.length; step++) {
      view!.props.onTabNext()
      await flush()
    }
    expect(submit).toBeDefined()
    submit!.props.onFinalResponse('submit')
    await flush()
    expect(onAllow).toHaveBeenCalledTimes(1)
    const answers = onAllow.mock.calls[0]![0].answers
    expect(answers).toEqual(answeredIndex === undefined ? {} : { [questions[answeredIndex]!.question]: 'No' })
    const parsed = AskUserQuestionTool.inputSchema.parse(onAllow.mock.calls[0]![0])
    const selections = takeQuestionSelections('terminal-partial-regression', parsed.questions, parsed.answers)
    expect(selections).toHaveLength(answeredIndex === undefined ? 0 : 1)
    if (answeredIndex !== undefined) expect(selections![0]).toMatchObject({ questionIndex: answeredIndex, selectedOptions: [{ optionIndex: 1, label: 'No' }] })
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
}

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

test('multi-select forwards raw selections and separate Other text without flattening', async () => {
  const question = {
    question: 'Which choices?', options: [
      { label: 'A, B', description: 'One choice' },
      { label: 'A', description: 'Another choice' },
      { label: 'B', description: 'Third choice' },
    ], multiSelect: true,
  }
  const onAnswer = mock(() => {})
  let selectProps: React.ComponentProps<typeof SelectMulti> | undefined
  function inspect(node: React.ReactNode): void {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return
      if (child.type === SelectMulti) selectProps = child.props as React.ComponentProps<typeof SelectMulti>
      inspect(child.props.children)
    })
  }
  function InspectQuestion() {
    const node = QuestionView({
      question, questions: [question], currentQuestionIndex: 0,
      answers: {}, questionStates: { [question.question]: { textInputValue: 'A, B' } },
      onUpdateQuestionState() {}, onAnswer, onTextInputFocus() {}, onCancel() {},
      onSubmit() {}, onRespondToClaude() {}, onFinishPlanInterview() {},
    })
    inspect(node)
    return node
  }
  await renderQuestion(
    <AppStoreContext.Provider value={createStore(getDefaultAppState())}>
      <TerminalSizeContext.Provider value={{ columns: 100, rows: 40 }}>
        <InspectQuestion />
      </TerminalSizeContext.Provider>
    </AppStoreContext.Provider>,
  )
  expect(selectProps).toBeDefined()
  selectProps!.onChange!(['A, B'])
  expect(onAnswer).toHaveBeenLastCalledWith(question.question, ['A, B'], undefined, false)
  selectProps!.onChange!(['A', 'B'])
  expect(onAnswer).toHaveBeenLastCalledWith(question.question, ['A', 'B'], undefined, false)
  selectProps!.onChange!(['__other__'])
  expect(onAnswer).toHaveBeenLastCalledWith(question.question, ['__other__'], 'A, B', false)
})
