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
