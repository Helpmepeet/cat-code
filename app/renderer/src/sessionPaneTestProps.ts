/**
 * Shared `SessionPane` props for the renderer suites.
 *
 * Lifted out of `App.test.tsx` so the DOM suites can mount the same pane the
 * SSR suites render: two arrangements of one component drifting apart is how a
 * structural claim ends up proved against a pane nobody ships. A plain `.ts`
 * module, deliberately: every `.tsx` under `renderer/src` is subject to the
 * Fast Refresh component-boundary rule (`lint:fast-refresh`), and this file
 * exports a function rather than a component.
 */

import type { ComponentProps } from 'react'
import type { SessionPane } from './SessionPane.js'
import { createTranscriptState } from './transcriptProjector.js'

/** A minimal live, idle session pane. Spread and override the one field a test
 *  is about, so a prop added to SessionPane fails compilation once, here. */
export function idleSessionPaneProps(): ComponentProps<typeof SessionPane> {
  return {
    accountsSnapshot: null,
    accountsLastResult: null,
    orchestratorActive: false,
    activeConnection: { status: 'ready', inputEnabled: true },
    activeDescriptor: undefined,
    activeLog: {
      inputEnabled: true,
      messages: [],
      retainedBytes: 0,
      truncated: false,
      error: null,
      messageBytes: [],
    },
    activeAccount: null,
    activeSessionId: 'session-1',
    isActivePane: true,
    branch: null,
    allowPermission: () => {},
    model: null,
    reasoningEffort: null,
    fastMode: false,
    copyForLlm: () => {},
    denyPermission: () => {},
    history: [],
    mentionItems: [],
    onApprovePlan: () => {},
    onPaste: () => {},
    onRemovePaste: () => {},
    onRevisePlan: () => {},
    partialCount: 0,
    pastes: [],
    permissionContext: null,
    permissionQueue: [],
    planReview: null,
    askQuestion: null,
    onAnswerQuestions: () => {},
    onCancelQuestions: () => {},
    prompt: '',
    releasePendingSubmit: () => {},
    restorePermission: () => {},
    setPermissionMode: () => {},
    setPrompt: () => {},
    submit: () => {},
    transcript: createTranscriptState(),
    transportError: null,
  } satisfies ComponentProps<typeof SessionPane>
}
