import z from 'zod/v4'
import type {
  AppGoalSnapshot,
  AppPermissionRequest,
  AppPermissionResponse,
  AppSessionAbortState,
} from '../app-runtime/sessionEvents.js'
import { outputSchema as permissionResponseSchema } from '../utils/permissions/PermissionPromptToolResultSchema.js'

const requestIdSchema = z.string().min(1)

const appSubmitMessageSchema = z.object({
  type: z.literal('app.submit'),
  requestId: requestIdSchema,
  prompt: z.string().min(1),
  options: z
    .object({
      uuid: z.string().optional(),
      isMeta: z.boolean().optional(),
      goalSnapshot: z.unknown().optional(),
    })
    .optional(),
})

const appAbortMessageSchema = z.object({
  type: z.literal('app.abort'),
  requestId: requestIdSchema,
  reason: z.string().optional(),
})

const permissionResponseMessageSchema = z.object({
  type: z.literal('permission.response'),
  requestId: requestIdSchema,
  response: permissionResponseSchema(),
})

const appPingMessageSchema = z.object({
  type: z.literal('app.ping'),
  nonce: z.string().min(1),
})

export const appClientMessageSchema = z.union([
  appSubmitMessageSchema,
  appAbortMessageSchema,
  permissionResponseMessageSchema,
  appPingMessageSchema,
])

const abortStateSchema = z.union([
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('requested'), reason: z.string().optional() }),
  z.object({ status: z.literal('aborted'), reason: z.string().optional() }),
])

const browserMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  sdkType: z.string().optional(),
  sdkSubtype: z.string().optional(),
})

const appBrowserEventSchema = z.union([
  z.object({
    type: z.literal('message.append'),
    message: browserMessageSchema,
  }),
  z.object({
    type: z.literal('message.replace'),
    message: browserMessageSchema,
  }),
  z.object({
    type: z.literal('message.delta'),
    id: z.string().optional(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('status.update'),
    connected: z.boolean().optional(),
    inputEnabled: z.boolean().optional(),
    activeTurn: z.boolean().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    contextTokens: z.number().optional(),
    notice: z.string().optional(),
  }),
  z.object({
    type: z.literal('goal.snapshot'),
    snapshot: z.unknown(),
  }),
  z.object({
    type: z.literal('permission.requested'),
    request: z.unknown(),
  }),
  z.object({
    type: z.literal('permission.resolved'),
    requestId: z.string(),
    response: z.unknown(),
  }),
  z.object({
    type: z.literal('abort.status'),
    abort: abortStateSchema,
  }),
])

export const appServerMessageSchema = z.union([
  z.object({
    type: z.literal('app.ready'),
    protocolVersion: z.literal(1),
    inputEnabled: z.boolean(),
    abort: abortStateSchema,
    goalSnapshot: z.unknown(),
    pendingPermissionRequests: z.array(z.unknown()),
  }),
  z.object({
    type: z.literal('app.event'),
    event: appBrowserEventSchema,
  }),
  z.object({
    type: z.literal('app.ack'),
    requestId: requestIdSchema,
  }),
  z.object({
    type: z.literal('app.error'),
    requestId: z.string().optional(),
    code: z.enum([
      'bad_request',
      'turn_already_running',
      'permission_not_found',
      'unauthorized',
      'internal_error',
    ]),
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({
    type: z.literal('app.pong'),
    nonce: z.string(),
  }),
])

export type AppClientMessage = z.infer<typeof appClientMessageSchema>
export type AppSubmitMessage = z.infer<typeof appSubmitMessageSchema>
export type PermissionResponseMessage = z.infer<
  typeof permissionResponseMessageSchema
>
export type AppServerMessage = z.infer<typeof appServerMessageSchema>
export type AppBrowserEvent = z.infer<typeof appBrowserEventSchema>

export type AppReadyPayload = {
  protocolVersion: 1
  inputEnabled: boolean
  abort: AppSessionAbortState
  goalSnapshot: AppGoalSnapshot
  pendingPermissionRequests: AppPermissionRequest[]
}

export type AppPermissionResponsePayload = AppPermissionResponse
