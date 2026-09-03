import { expect, test } from 'bun:test'

import type {
  CreateSessionInput,
  CreateSessionRequest,
  SessionDescriptor,
} from './hostApi.js'

type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false
type IsRequiredBoolean<T, K extends keyof T> =
  T[K] extends boolean ? (boolean extends T[K] ? true : false) : false

test('fork provenance exists only on the trusted create request and descriptor', () => {
  const internalRequestHasForked: HasKey<CreateSessionRequest, 'forked'> = true
  const internalRequestForkedIsOptional: IsOptional<
    CreateSessionRequest,
    'forked'
  > = true
  const rendererInputHasForked: HasKey<CreateSessionInput, 'forked'> = false
  const descriptorHasRequiredForked: IsRequiredBoolean<
    SessionDescriptor,
    'forked'
  > = true

  expect(internalRequestHasForked).toBe(true)
  expect(internalRequestForkedIsOptional).toBe(true)
  expect(rendererInputHasForked).toBe(false)
  expect(descriptorHasRequiredForked).toBe(true)
})

test('peer identity and the wake block are descriptor state, never a renderer create input', () => {
  // PEER-SESSIONS §2/§6: the sidebar row and its menu render the name and the
  // wake block from the descriptor, so both must be READABLE there — a
  // write-only toggle cannot show its own state. Neither may appear on the
  // renderer-facing create input, which carries a picker token and a title and
  // nothing a compromised renderer could use to author identity (HC1/T8).
  const descriptorHasName: HasKey<SessionDescriptor, 'name'> = true
  const descriptorHasPeerWakeBlocked: HasKey<SessionDescriptor, 'peerWakeBlocked'> = true
  // The creator rides as an ID so the renderer can build the seam row (§6).
  // There is deliberately no resolved creator NAME beside it: names are reused
  // after a reap, so one baked into a descriptor would outlive its row (§2).
  const descriptorHasCreatedBy: HasKey<SessionDescriptor, 'createdBy'> = true
  const descriptorHasCreatedByName: HasKey<SessionDescriptor, 'createdByName'> = false
  expect(descriptorHasCreatedBy).toBe(true)
  expect(descriptorHasCreatedByName).toBe(false)
  const rendererInputHasName: HasKey<CreateSessionInput, 'name'> = false
  const rendererInputHasCreatedBy: HasKey<CreateSessionInput, 'createdBy'> = false
  // The trusted internal request does not carry them either: a peer create goes
  // through `createSessionInWorkspace` with host-only options, not through this.
  const internalRequestHasName: HasKey<CreateSessionRequest, 'name'> = false

  expect(descriptorHasName).toBe(true)
  expect(descriptorHasPeerWakeBlocked).toBe(true)
  expect(rendererInputHasName).toBe(false)
  expect(rendererInputHasCreatedBy).toBe(false)
  expect(internalRequestHasName).toBe(false)
})
