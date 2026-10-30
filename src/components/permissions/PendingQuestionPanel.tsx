// eslint-disable-next-line custom-rules/prefer-use-keybindings -- Meta+J is the question dock toggle, shared with desktop.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { ContentBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { QuestionView } from './AskUserQuestionPermissionRequest/QuestionView.js'
import type { QuestionState } from './AskUserQuestionPermissionRequest/use-multiple-choice-state.js'
import { PendingQuestionRegistry, questionKey, type PendingQuestion, type QuestionAnswer, type QuestionReplyImage } from '../../utils/pendingQuestions.js'
import type { PastedContent } from '../../utils/config.js'
import { maybeResizeAndDownsampleImageBlock } from '../../utils/imageResizer.js'
import { logError } from '../../utils/log.js'
import { cacheImagePath, reserveImageId, storeImage } from '../../utils/imageStore.js'

type Draft = { answer: QuestionAnswer; state: QuestionState; images: Record<number, PastedContent> }
const empty = (): Draft => ({ answer: { optionIndices: [] }, state: { textInputValue: '' }, images: {} })

/** Non-modal: the engine continues while this surface is collapsed or open. */
export function PendingQuestionPanel({ registry, active, onOpenChange, onMessage, deliver, planMode = false }: {
  registry: PendingQuestionRegistry
  active: boolean
  onOpenChange: (open: boolean) => void
  onMessage: (prompt: string | ContentBlockParam[]) => void
  deliver: () => void
  planMode?: boolean
}) {
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const [open, setOpen] = useState(false)
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const busy = useRef(false)
  const current = snapshot.pending.find(q => questionKey(q) === currentKey) ?? snapshot.pending[0]
  const key = current ? questionKey(current) : ''
  const draft = drafts[key] ?? empty()
  const setExpanded = (value: boolean) => { setOpen(value); onOpenChange(value && active) }
  useEffect(() => { onOpenChange(open && active); return () => onOpenChange(false) }, [open, active])
  useEffect(() => { if (snapshot.pending.length === 0 && open) setExpanded(false) }, [snapshot.pending.length, open])
  function update(value: Draft) {
    if (busy.current) return
    const next = { ...draftsRef.current, [key]: value }
    draftsRef.current = next
    setDrafts(next)
  }
  async function imageBlocks(value: Draft): Promise<QuestionReplyImage[]> {
    return Promise.all(Object.values(value.images).map(async image => {
      const resized = await maybeResizeAndDownsampleImageBlock({ type: 'image', source: { type: 'base64', media_type: (image.mediaType || 'image/png') as 'image/png', data: image.content } })
      return resized.block as QuestionReplyImage
    }))
  }
  async function close() {
    if (busy.current) return
    busy.current = true
    const draftsAtClose = draftsRef.current
    setExpanded(false)
    try {
      const replies = []
      for (const question of snapshot.pending) {
        const value = draftsAtClose[questionKey(question)]
        if (!value || !value.answer.optionIndices.length && !value.answer.other?.trim() && !Object.keys(value.images).length) continue
        const images = await imageBlocks(value)
        replies.push({ toolUseId: question.toolUseId, questionIndex: question.questionIndex, answer: value.answer, ...(images.length ? { images } : {}) })
      }
      if (replies.length) await registry.reply({ requestId: crypto.randomUUID(), replies })
      setExpanded(false)
      deliver()
    } catch (error) { logError(error) }
    finally { busy.current = false }
  }
  useInput((input, key) => {
    if (busy.current) return
    if (key.meta && input.toLowerCase() === 'j') {
      if (open) void close()
      else setExpanded(true)
    }
  }, { isActive: active && snapshot.pending.length > 0 })
  if (!current) return null
  if (!open || !active) return <Box onClick={() => { if (active && !busy.current) setExpanded(true) }}><Text color="text">? {snapshot.pending[0]!.question}{snapshot.pending.length > 1 ? `  ${snapshot.pending.length} pending` : ''}</Text></Box>
  const all = snapshot.pending
  const at = all.findIndex(q => questionKey(q) === key)
  const callQuestions = all.filter(q => q.toolUseId === current.toolUseId)
  const callIndex = callQuestions.findIndex(q => questionKey(q) === key)
  function move(delta: number) { setCurrentKey(questionKey(all[(at + delta + all.length) % all.length]!)) }
  function choose(_text: string, labels: string | string[], textInput?: string, advance = true) {
    if (busy.current) return
    const previous = draftsRef.current[key] ?? empty()
    const selected = Array.isArray(labels) ? labels : [labels]
    const optionIndices = current!.options.flatMap((option, index) => selected.includes(option.label) ? [index] : [])
    const other = selected.includes('__other__') ? (textInput ?? previous.state.textInputValue).trim() : undefined
    const note = textInput ?? (!current!.multiSelect && current!.options.some(option => option.preview) ? previous.state.textInputValue : '')
    const notes = !other && note.trim() && optionIndices.length === 1 ? [{ optionIndex: optionIndices[0]!, text: note.trim() }] : undefined
    update({ ...draftsRef.current[key] ?? empty(), answer: { optionIndices, ...(other ? { other } : {}), ...(notes ? { notes } : {}) } })
    if (!advance) return
    const next = all.find(question => {
      const value = draftsRef.current[questionKey(question)]
      return !value?.answer.optionIndices.length && !value?.answer.other?.trim() && !Object.keys(value?.images ?? {}).length
    })
    if (next) setCurrentKey(questionKey(next))
    else void close()
  }
  async function dismiss() {
    if (busy.current) return
    try { await registry.dismiss({ requestId: crypto.randomUUID(), toolUseId: current!.toolUseId, questionIndex: current!.questionIndex }); setCurrentKey(null) }
    catch (error) { logError(error) }
  }
  async function respond(finish: boolean) {
    if (busy.current) return
    busy.current = true
    setExpanded(false)
    try {
      const images = (await Promise.all(snapshot.pending.flatMap(q => {
        const draft = draftsRef.current[questionKey(q)]
        return draft ? [imageBlocks(draft)] : []
      }))).flat() as ImageBlockParam[]
      const summary = snapshot.pending.map(question => {
        const value = draftsRef.current[questionKey(question)]?.answer
        const answer = value ? [...value.optionIndices.map(index => question.options[index]!.label), ...(value.other?.trim() ? [value.other.trim()] : [])].join(', ') : ''
        return `- "${question.question}"\n  ${answer ? `Answer: ${answer}` : '(No answer provided)'}`
      }).join('\n')
      if (finish) for (const question of snapshot.pending) await registry.dismiss({ requestId: crypto.randomUUID(), toolUseId: question.toolUseId, questionIndex: question.questionIndex })
      const feedback = finish
        ? 'The user has indicated they have provided enough answers for the plan interview. Stop asking clarifying questions and proceed to finish the plan with the information you have.'
        : 'The user wants to clarify these questions. Start by asking what they would like to clarify. The questions remain pending.'
      const text = `${feedback}\n\nQuestions asked and answers provided:\n${summary}`
      setExpanded(false)
      onMessage(images.length ? [{ type: 'text', text }, ...images] : text)
    } finally { busy.current = false }
  }
  return <QuestionView
    key={key} question={current} questions={callQuestions} currentQuestionIndex={callIndex}
    answers={Object.fromEntries(callQuestions.flatMap(q => {
      const draft = drafts[questionKey(q)]
      const answer = draft?.answer
      const images = Object.keys(draft?.images ?? {}).length
      return answer && (answer.optionIndices.length || answer.other || images) ? [[q.question, [...answer.optionIndices.map(index => q.options[index]!.label), ...(answer.other ? [answer.other] : []), ...(images ? ['(Image attached)'] : [])].join(', ')]] : []
    }))}
    questionStates={{ [current.question]: draft.state }} hideSubmitTab
    pastedContents={draft.images}
    onUpdateQuestionState={(_text: string, change: Partial<QuestionState>) => {
      const state = { ...(draftsRef.current[key]?.state ?? empty().state), ...change }
      const labels = Array.isArray(state.selectedValue) ? state.selectedValue : state.selectedValue ? [state.selectedValue] : []
      const optionIndices = current.options.flatMap((option, index) => labels.includes(option.label) ? [index] : [])
      update({ ...(draftsRef.current[key] ?? empty()), state, answer: { optionIndices, ...(labels.includes('__other__') && state.textInputValue.trim() ? { other: state.textInputValue } : {}), ...(!labels.includes('__other__') && optionIndices.length === 1 && state.textInputValue.trim() ? { notes: [{ optionIndex: optionIndices[0]!, text: state.textInputValue }] } : {}) } })
    }}
    onAnswer={choose} onTextInputFocus={() => {}} onCancel={() => { void dismiss() }} onSubmit={() => { void close() }}
    onTabPrev={() => move(-1)} onTabNext={() => move(1)}
    onRespondToClaude={() => { void respond(false).catch(logError) }}
    onFinishPlanInterview={() => { if (planMode) void respond(true).catch(logError) }}
    onImagePaste={async (content: string, mediaType?: string, filename?: string, dimensions?: PastedContent['dimensions']) => {
      if (busy.current) return
      const id = reserveImageId()
      const image: PastedContent = { id, type: 'image', content, mediaType: mediaType || 'image/png', filename: filename || 'Pasted image', dimensions }
      cacheImagePath(image)
      update({ ...draftsRef.current[key] ?? empty(), images: { ...(draftsRef.current[key]?.images ?? {}), [id]: image } })
      await storeImage(image).catch(logError)
    }}
    onRemoveImage={(id: number) => { const value = draftsRef.current[key] ?? empty(); const images = { ...value.images }; delete images[id]; update({ ...value, images }) }}
  />
}
