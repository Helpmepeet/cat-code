import { describe, expect, test } from 'bun:test'
import type { SessionId } from '../../shared/protocol.js'
import {
  createResumeUiState,
  reduceResumeUiState,
  type ResumeUiState,
} from './resumeDialogState.js'

const SID: SessionId = 'session-1'

describe('resumeDialogState', () => {
  test('starts idle', () => {
    expect(createResumeUiState()).toEqual({ kind: 'idle' })
  })

  test('requested opens the confirm dialog for the picked session', () => {
    const next = reduceResumeUiState(createResumeUiState(), {
      type: 'requested',
      sessionId: SID,
    })
    expect(next).toEqual({ kind: 'confirm', sessionId: SID })
  })

  test('requested cannot replace an in-flight hydration overlay', () => {
    const hydrating: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    }
    expect(
      reduceResumeUiState(hydrating, {
        type: 'requested',
        sessionId: 'other-session',
      }),
    ).toBe(hydrating)
  })

  test('confirmed moves confirm -> hydrating for the same session', () => {
    const confirm: ResumeUiState = { kind: 'confirm', sessionId: SID }
    expect(reduceResumeUiState(confirm, { type: 'confirmed' })).toEqual({
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    })
  })

  test('attached marks hydrating after the restored sidecar ready frame', () => {
    const hydrating: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    }
    expect(
      reduceResumeUiState(hydrating, { type: 'attached', sessionId: SID }),
    ).toEqual({
      kind: 'hydrating',
      sessionId: SID,
      attached: true,
    })
    expect(
      reduceResumeUiState(hydrating, {
        type: 'attached',
        sessionId: 'other-session',
      }),
    ).toBe(hydrating)
  })

  test('replayed clears hydrating after a real replay frame for the same session', () => {
    const hydrating: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: true,
    }
    expect(
      reduceResumeUiState(hydrating, { type: 'replayed', sessionId: SID }),
    ).toEqual({ kind: 'idle' })
    expect(
      reduceResumeUiState(hydrating, {
        type: 'replayed',
        sessionId: 'other-session',
      }),
    ).toBe(hydrating)
  })

  test('replaySettled clears only after ready when no replay frame arrives', () => {
    const unattached: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    }
    const attached: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: true,
    }
    expect(
      reduceResumeUiState(unattached, {
        type: 'replaySettled',
        sessionId: SID,
      }),
    ).toBe(unattached)
    expect(
      reduceResumeUiState(attached, {
        type: 'replaySettled',
        sessionId: SID,
      }),
    ).toEqual({ kind: 'idle' })
  })

  test('cancelled from confirm returns to idle; ignored elsewhere', () => {
    const confirm: ResumeUiState = { kind: 'confirm', sessionId: SID }
    expect(reduceResumeUiState(confirm, { type: 'cancelled' })).toEqual({
      kind: 'idle',
    })
    const hydrating: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    }
    expect(reduceResumeUiState(hydrating, { type: 'cancelled' })).toBe(
      hydrating,
    )
  })

  test('failed from hydrating carries the real error message', () => {
    const hydrating: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    }
    expect(
      reduceResumeUiState(hydrating, {
        type: 'failed',
        message: 'transcript for X is gone',
      }),
    ).toEqual({
      kind: 'failed',
      sessionId: SID,
      message: 'transcript for X is gone',
    })
  })

  test('confirmed (Retry) moves failed -> hydrating for the same session', () => {
    const failed: ResumeUiState = {
      kind: 'failed',
      sessionId: SID,
      message: 'boom',
    }
    expect(reduceResumeUiState(failed, { type: 'confirmed' })).toEqual({
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    })
  })

  test('dismissed (Start fresh) from failed or hydrating returns to idle', () => {
    const failed: ResumeUiState = {
      kind: 'failed',
      sessionId: SID,
      message: 'boom',
    }
    expect(reduceResumeUiState(failed, { type: 'dismissed' })).toEqual({
      kind: 'idle',
    })
    const hydrating: ResumeUiState = {
      kind: 'hydrating',
      sessionId: SID,
      attached: false,
    }
    expect(reduceResumeUiState(hydrating, { type: 'dismissed' })).toEqual({
      kind: 'idle',
    })
  })

  test('dismissed from idle/confirm is a no-op', () => {
    const idle: ResumeUiState = { kind: 'idle' }
    expect(reduceResumeUiState(idle, { type: 'dismissed' })).toBe(idle)
    const confirm: ResumeUiState = { kind: 'confirm', sessionId: SID }
    expect(reduceResumeUiState(confirm, { type: 'dismissed' })).toBe(confirm)
  })
})
