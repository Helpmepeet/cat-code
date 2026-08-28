import z from 'zod/v4'
import type {
  AppGoalSnapshot,
  AppPermissionRequest,
  AppPermissionResponse,
  AppSessionAbortState,
} from './sessionEvents.js'
import { outputSchema as permissionResponseSchema } from '../utils/permissions/PermissionPromptToolResultSchema.js'

const requestIdSchema = z.string().min(1)
const appSubmitImageBase64Chars = 90_000

const appSubmitImageBlockSchema = z.strictObject({
  type: z.literal('image'),
  source: z.strictObject({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z
      .string()
      .min(1)
      .max(appSubmitImageBase64Chars)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  }),
})

const appSubmitTextBlockSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1),
})

const appSubmitPromptSchema = z.union([
  z.string().min(1),
  z
    .array(z.union([appSubmitImageBlockSchema, appSubmitTextBlockSchema]))
    .min(1)
    .max(5)
    .refine(
      blocks => blocks.some(block => block.type === 'image'),
      'content-block prompts must include an image',
    )
    .refine(
      blocks =>
        blocks.reduce(
          (total, block) =>
            total + (block.type === 'image' ? block.source.data.length : 0),
          0,
        ) <= appSubmitImageBase64Chars,
      'image data exceeds the submit budget',
    ),
])

const appSubmitMessageSchema = z.object({
  type: z.literal('app.submit'),
  requestId: requestIdSchema,
  prompt: appSubmitPromptSchema,
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

export type AppClientMessage = z.infer<typeof appClientMessageSchema>
export type AppSubmitPrompt = z.infer<typeof appSubmitPromptSchema>
export type AppSubmitMessage = z.infer<typeof appSubmitMessageSchema>
export type PermissionResponseMessage = z.infer<
  typeof permissionResponseMessageSchema
>

export type AppReadyPayload = {
  type: 'app.ready'
  protocolVersion: 1
  inputEnabled: boolean
  activeTurn: boolean
  abort: AppSessionAbortState
  goalSnapshot: AppGoalSnapshot
  pendingPermissionRequests: AppPermissionRequest[]
}

export type AppPermissionResponsePayload = AppPermissionResponse
