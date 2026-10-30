import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { render } from '../../ink.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { AppStoreContext } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'
import { PendingQuestionRegistry, type PendingQuestionSpec } from '../../utils/pendingQuestions.js'
import { PendingQuestionPanel } from './PendingQuestionPanel.js'
import { QuestionView } from './AskUserQuestionPermissionRequest/QuestionView.js'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { releaseActiveTranscriptLease } from '../../utils/transcriptLease.js'
import { cacheImagePath, clearStoredImagePaths, getStoredImagePath, reserveImageId } from '../../utils/imageStore.js'

const originalSession = getSessionId()
const originalProject = getSessionProjectDir()
const originalConfig = process.env.CLAUDE_CONFIG_DIR
const instances: Awaited<ReturnType<typeof render>>[] = []
let dir: string
beforeEach(async () => {
  await releaseActiveTranscriptLease()
  dir = mkdtempSync(join(tmpdir(), 'pending-question-panel-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  switchSession(asSessionId(randomUUID()), dir)
})
afterEach(async () => {
  for (const instance of instances.splice(0)) instance.unmount()
  await releaseActiveTranscriptLease()
  clearStoredImagePaths()
  switchSession(asSessionId(originalSession), originalProject)
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  rmSync(dir, { recursive: true, force: true })
})
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000
  while (!predicate()) { if (Date.now() > end) throw new Error('Terminal question render did not settle'); await new Promise(resolve => setImmediate(resolve)) }
}
async function harness(questions: PendingQuestionSpec[], plan = false) {
  const registry = new PendingQuestionRegistry(async () => {})
  await registry.ask('call', 'source', questions)
  const messages: unknown[] = []
  const open: boolean[] = []
  let node: React.ReactElement<any> | null = null
  let questionTree: React.ReactNode = null
  function Probe(props: React.ComponentProps<typeof QuestionView>) {
    questionTree = QuestionView(props)
    return questionTree
  }
  const state = getDefaultAppState()
  if (plan) state.toolPermissionContext.mode = 'plan'
  function Inspect() {
    const rendered = PendingQuestionPanel({ registry, active: true, planMode: plan, onOpenChange: value => open.push(value), onMessage: value => messages.push(value), deliver() {} })
    node = React.isValidElement(rendered) ? rendered : null
    return node?.type === QuestionView ? <Probe key={node.key} {...node.props} /> : rendered
  }
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40 })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const instance = await render(<AppStoreContext.Provider value={createStore(state)}><TerminalSizeContext.Provider value={{ columns: 100, rows: 40 }}><Inspect /></TerminalSizeContext.Provider></AppStoreContext.Provider>, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false })
  instances.push(instance)
  await until(() => node !== null)
  const show = async () => { node!.props.onClick(); await until(() => node?.type === QuestionView); return node!.props }
  return { registry, messages, open, show, props: () => node!.props, output: () => output, stdin, multi: () => findMulti(questionTree) }
}
const question: PendingQuestionSpec = { question: 'Which layout?', multiSelect: false, options: [{ label: 'Stacked', description: 'One column', preview: 'Stacked preview' }, { label: 'Split', description: 'Two columns', preview: 'Split preview' }] }

function findMulti(node: React.ReactNode): React.ReactElement<any> | undefined {
  if (!React.isValidElement<any>(node)) return
  if (node.props.onChange && Array.isArray(node.props.options) && 'submitButtonText' in node.props) return node
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findMulti(child)
    if (found) return found
  }
}

test.each([
  { labels: ['Stacked', '__other__'], text: 'Custom layout', indices: [0] },
  { labels: ['__other__'], text: 'Custom layout', indices: [] },
  { labels: ['__other__'], text: 'Split', indices: [] },
  { labels: ['Stacked', '__other__'], text: 'Stacked', indices: [0] },
])('real terminal multiselect retains Other until explicit close: %j', async ({ labels, text, indices }) => {
  const h = await harness([{ ...question, multiSelect: true }])
  const reply = spyOn(h.registry, 'reply')
  await h.show()
  h.props().onUpdateQuestionState(question.question, { textInputValue: text })
  await until(() => h.props().questionStates[question.question].textInputValue === text)
  h.multi()!.props.onChange(labels)
  await until(() => h.props().questionStates[question.question].selectedValue?.includes('__other__'))
  expect(h.registry.undelivered(new Set())).toEqual([])
  expect(h.registry.getSnapshot().pending).toHaveLength(1)
  h.props().onSubmit()
  await until(() => h.open.at(-1) === false)
  await new Promise(resolve => setImmediate(resolve))
  const delivery = h.registry.undelivered(new Set())[0]
  expect(delivery).toBeDefined()
  expect(reply.mock.calls[0]?.[0].replies[0]?.answer).toEqual({ optionIndices: [...indices], other: text })
  expect(JSON.parse(delivery!.content)[0].answer).toBe([...indices.map(index => question.options[index]!.label), text].join(', '))
})

test('terminal question arrival is non-modal and headerless navigation retains Q1', async () => {
  const h = await harness([question])
  expect(h.output()).toContain('Which layout?')
  expect(h.open.every(value => !value)).toBe(true)
  await h.show()
  expect(h.output()).not.toContain('undefined')
  expect(h.registry.getSnapshot().pending).toHaveLength(1)
  expect(h.registry.undelivered(new Set())).toEqual([])
})

test.each(['deselect', 'clear'] as const)('real terminal multiselect %s removes stale Other without delivery', async action => {
  const h = await harness([{ ...question, multiSelect: true }])
  const reply = spyOn(h.registry, 'reply')
  await h.show()
  h.props().onUpdateQuestionState(question.question, { textInputValue: 'Custom layout' })
  await until(() => h.props().questionStates[question.question].textInputValue === 'Custom layout')
  h.multi()!.props.onChange(['__other__'])
  await until(() => h.props().questionStates[question.question].selectedValue?.includes('__other__'))
  if (action === 'clear') {
    h.multi()!.props.options.find((option: { value: string }) => option.value === '__other__').onChange('')
    await until(() => h.props().questionStates[question.question].textInputValue === '')
    h.multi()!.props.onChange(['__other__'])
  } else h.multi()!.props.onChange([])
  h.props().onSubmit()
  await until(() => h.open.at(-1) === false)
  expect(reply).not.toHaveBeenCalled()
  expect(h.registry.getSnapshot().pending).toHaveLength(1)
  expect(h.registry.undelivered(new Set())).toEqual([])
  await until(() => typeof h.props().onClick === 'function')
  await h.show()
  h.multi()!.props.onChange(['Stacked'])
  await until(() => h.props().questionStates[question.question].selectedValue?.[0] === 'Stacked')
  h.props().onSubmit()
  await until(() => h.registry.getSnapshot().pending.length === 0)
  expect(reply.mock.calls[0]?.[0].replies[0]?.answer).toEqual({ optionIndices: [0] })
})

test('terminal previews and notes reach a later reply rather than the immediate tool result', async () => {
  const h = await harness([question])
  let props = await h.show()
  props.onUpdateQuestionState(question.question, { selectedValue: 'Split', textInputValue: 'Keep the summary visible' }, false)
  await until(() => h.props().questionStates?.[question.question]?.textInputValue === 'Keep the summary visible')
  props = h.props()
  props.onAnswer(question.question, 'Split')
  await until(() => h.registry.getSnapshot().pending.length === 0)
  const delivery = h.registry.undelivered(new Set())[0]!
  expect(JSON.parse(delivery.content)[0]).toMatchObject({ question: 'Which layout?', answer: 'Split', notes: 'Split: Keep the summary visible', selectedPreview: 'Split preview' })
  expect(h.open.at(-1)).toBe(false)
})

test('terminal respond-to-Claude keeps questions pending, while finish-plan-interview silently dismisses them', async () => {
  const chat = await harness([question])
  const props = await chat.show()
  props.onRespondToClaude()
  await until(() => chat.messages.length === 1)
  expect(chat.registry.getSnapshot().pending).toHaveLength(1)
  expect(chat.registry.undelivered(new Set())).toEqual([])
  expect(String(chat.messages[0])).toContain(question.question)
  const finish = await harness([question], true)
  const finishProps = await finish.show()
  finishProps.onFinishPlanInterview()
  await until(() => finish.messages.length === 1)
  expect(finish.registry.getSnapshot().pending).toHaveLength(0)
  expect(finish.registry.getSnapshot().resolved[0]?.state).toBe('dismissed')
  expect(finish.registry.undelivered(new Set())).toEqual([])
  expect(String(finish.messages[0])).toContain('provided enough answers')
})

test('pasted terminal images survive a question switch and do not overwrite composer image ids', async () => {
  const h = await harness([{ question: 'What should it look like?', options: [], multiSelect: false }, { ...question, question: 'Which layout next?' }])
  const props = await h.show()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3i8AAAAASUVORK5CYII='
  await props.onImagePaste(png, 'image/png', 'example.png')
  await until(() => Object.keys(h.props().pastedContents ?? {}).length === 1)
  const id = Number(Object.keys(h.props().pastedContents)[0])
  const path = getStoredImagePath(id)
  expect(path).toContain(dir)
  const composerId = reserveImageId(0)
  cacheImagePath({ id: composerId, type: 'image', content: png, mediaType: 'image/png' })
  expect(composerId).not.toBe(id)
  expect(getStoredImagePath(id)).toBe(path)
  h.props().onAnswer('What should it look like?', '__other__')
  await until(() => h.props().question?.question === 'Which layout next?')
  h.props().onAnswer('Which layout next?', 'Stacked')
  await until(() => h.registry.getSnapshot().pending.length === 0)
  const delivery = h.registry.undelivered(new Set())[0]!
  expect(delivery.images).toHaveLength(1)
  expect(delivery.images![0]!.source.data).toBeTruthy()
  expect(JSON.parse(delivery.content)[0]).toMatchObject({ question: 'What should it look like?', answer: '(Image attached)', imageCount: 1 })
})
