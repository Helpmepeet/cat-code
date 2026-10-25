import z from 'zod/v4'
import type {
  AppGoalSnapshot,
  AppPermissionRequest,
  AppPermissionResponse,
  AppSessionAbortState,
} from './sessionEvents.js'
import { outputSchema as permissionResponseSchema } from '../utils/permissions/PermissionPromptToolResultSchema.js'

import {
  MAX_SUBMIT_IMAGE_BYTES,
  MAX_SUBMIT_IMAGES,
  MAX_SUBMIT_TEXT_BYTES,
  isSubmitImageBase64,
  validateAppSubmitPromptBudget,
} from './appSubmitLimits.js'

const requestIdSchema = z.string().min(1)

const appSubmitImageBlockSchema = z.strictObject({
  type: z.literal('image'),
  source: z.strictObject({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z
      .string()
      .min(1)
      .max(MAX_SUBMIT_IMAGE_BYTES)
      .refine(isSubmitImageBase64),
  }),
})

const appSubmitTextBlockSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1).max(MAX_SUBMIT_TEXT_BYTES),
})

const appSubmitPromptSchema = z.union([
  z.string().min(1).max(MAX_SUBMIT_TEXT_BYTES),
  z
    .array(z.union([appSubmitImageBlockSchema, appSubmitTextBlockSchema]))
    .min(1)
    .max(MAX_SUBMIT_IMAGES + 1)
    .refine(
      blocks => blocks.some(block => block.type === 'image'),
      'content-block prompts must include an image',
    )
]).superRefine((prompt, ctx) => {
  const error = validateAppSubmitPromptBudget(prompt)
  if (error) ctx.addIssue({ code: 'custom', message: error })
})

const appSubmitMessageSchema = z.object({
  type: z.literal('app.submit'),
  requestId: requestIdSchema,
  prompt: appSubmitPromptSchema,
  options: z
    .object({
      uuid: z.string().optional(),
      isMeta: z.boolean().optional(),
      goalSnapshot: z.unknown().optional(),
      observedProposal: z.strictObject({
        messageUuid: z.string().min(1).max(200),
        text: z.string().min(1).max(2000),
      }).nullable().optional(),
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
