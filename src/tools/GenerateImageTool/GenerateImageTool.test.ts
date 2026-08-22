import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  clearCodexOAuthTokens,
  saveCodexOAuthTokens,
} from '../../utils/auth.js'
import {
  _generateImageToolInternalsForTest,
  GenerateImageTool,
} from './GenerateImageTool.js'

const originalFetch = globalThis.fetch
const originalOpenAIKey = process.env.OPENAI_API_KEY
const originalImageBackend = process.env.CAT_CODE_IMAGE_BACKEND
let tempDir: string | undefined

function buildPoolAccount(accountId: string): PoolAccount {
  return {
    accountId,
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 5 * 60_000,
    source: 'config',
    status: 'healthy',
    lastUsedAt: 0,
  }
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function mintAccessJwt(accountId: string, serial: number): string {
  const header = b64url({ alg: 'none', typ: 'JWT' })
  const payload = b64url({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    email: 'image-auth-refresh@example.com',
    serial,
  })
  return `${header}.${payload}.test-sig`
}

function basePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  }
}

function clearCodexOAuthTokensForTest(): void {
  clearCodexOAuthTokens()
  delete getGlobalConfig().codexOAuth
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cat-code-image-gen-'))
  resetCodexLeaseManagerForTest()
  resetCodexAccountPoolForTest()
  clearCodexOAuthTokensForTest()
  process.env.OPENAI_API_KEY = 'test-openai-key'
  process.env.CAT_CODE_IMAGE_BACKEND = 'openai-api'
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey
  }
  if (originalImageBackend === undefined) {
    delete process.env.CAT_CODE_IMAGE_BACKEND
  } else {
    process.env.CAT_CODE_IMAGE_BACKEND = originalImageBackend
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
  clearCodexOAuthTokensForTest()
  resetCodexLeaseManagerForTest()
  resetCodexAccountPoolForTest()
})

describe('GenerateImageTool', () => {
  test('uses OPENAI_API_KEY when openai-api backend is forced even if Codex pool accounts exist', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount('main-account'),
        buildPoolAccount('backup-account'),
      ],
    })

    const imageBytes = Buffer.from('generated image')
    let requestUrl: string | undefined
    let requestBody: Record<string, unknown> | undefined
    let authorization: string | null = null
    let accountId: string | null = null

    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = new Headers(init?.headers)
      authorization = headers.get('authorization')
      accountId = headers.get('chatgpt-account-id')
      return new Response(
        JSON.stringify({
          data: [{ b64_json: imageBytes.toString('base64') }],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const outputPath = join(tempDir!, 'generated.png')
    const result = await GenerateImageTool.call(
      {
        prompt: 'a watercolor cat',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
      } as ToolUseContext,
    )

    expect(requestUrl).toBe('https://api.openai.com/v1/images/generations')
    expect(authorization).toBe('Bearer test-openai-key')
    expect(accountId).toBeNull()
    expect(requestBody).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'a watercolor cat',
      size: '1024x1024',
      output_format: 'png',
    })
    expect(await readFile(outputPath)).toEqual(imageBytes)
    expect(result.data.filePath).toBe(outputPath)
    expect(result.data.outputFormat).toBe('png')
  })

  test('uses OPENAI_API_KEY fallback when no image backend is forced', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND

    const imageBytes = Buffer.from('generated image')
    let requestUrl: string | undefined
    let authorization: string | null = null
    let accountId: string | null = null

    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      const headers = new Headers(init?.headers)
      authorization = headers.get('authorization')
      accountId = headers.get('chatgpt-account-id')
      return new Response(
        JSON.stringify({
          data: [{ b64_json: imageBytes.toString('base64') }],
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const outputPath = join(tempDir!, 'generated.png')
    const result = await GenerateImageTool.call(
      {
        prompt: 'a watercolor cat',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
      } as ToolUseContext,
    )

    expect(requestUrl).toBe('https://api.openai.com/v1/images/generations')
    expect(authorization).toBe('Bearer test-openai-key')
    expect(accountId).toBeNull()
    expect(await readFile(outputPath)).toEqual(imageBytes)
    expect(result.data.filePath).toBe(outputPath)
  })

  test('rejects an existing output path unless overwrite is true', async () => {
    const outputPath = join(tempDir!, 'existing.png')
    await writeFile(outputPath, 'already here')

    const validation = await GenerateImageTool.validateInput?.(
      {
        prompt: 'a watercolor cat',
        output_path: outputPath,
      },
      {} as ToolUseContext,
    )

    expect(validation).toEqual({
      result: false,
      message: 'output_path already exists. Set overwrite to true to replace it.',
      errorCode: 4,
    })
  })

  test('defaults generated images to the config artifacts directory', async () => {
    const input = {
      prompt: 'a watercolor cat',
    } as {
      prompt: string
      output_path?: string
    }

    const validation = await GenerateImageTool.validateInput?.(
      input,
      {} as ToolUseContext,
    )

    expect(validation).toEqual({ result: true })
    expect(input.output_path).toContain(
      join(getClaudeConfigHomeDir(), 'generated-images'),
    )
    expect(input.output_path).toMatch(
      /\/\.cat-code\/generated-images\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-a-watercolor-cat-[a-f0-9]{8}\.png$/,
    )
  })

  test('allows writes to the config generated-images artifact directory', async () => {
    const outputPath = join(
      getClaudeConfigHomeDir(),
      'generated-images',
      'generated.png',
    )

    const result = await GenerateImageTool.checkPermissions?.(
      {
        prompt: 'a watercolor cat',
        output_path: outputPath,
      },
      {
        getAppState: () => ({
          toolPermissionContext: basePermissionContext(),
        }),
      } as ToolUseContext,
    )

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        prompt: 'a watercolor cat',
        output_path: outputPath,
      },
    })
  })

  test('builds a Codex Responses image-generation request', () => {
    const body =
      _generateImageToolInternalsForTest.buildCodexImageGenerationBody(
        {
          prompt: 'a watercolor cat',
          output_path: join(tempDir!, 'generated.png'),
        },
        'png',
        'gpt-5.6-terra',
      )

    expect(body).toMatchObject({
      model: 'gpt-5.6-terra',
      instructions: 'Generate the requested image using the image_generation tool.',
      stream: true,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'a watercolor cat' }],
        },
      ],
      tools: [
        {
          type: 'image_generation',
          size: '1024x1024',
          quality: 'auto',
          output_format: 'png',
        },
      ],
      tool_choice: 'required',
    })
  })

  test('accepts the Codex image-generation request parameters in the input schema', () => {
    const result = GenerateImageTool.inputSchema.safeParse({
      prompt: 'a watercolor cat',
      output_path: join(tempDir!, 'generated.webp'),
      output_format: 'webp',
      output_compression: 80,
      action: 'generate',
      input_fidelity: 'high',
    })

    expect(result.success).toBe(true)
  })

  test('passes optional Codex image-generation request parameters to the built-in tool', () => {
    const body =
      _generateImageToolInternalsForTest.buildCodexImageGenerationBody(
        {
          prompt: 'a watercolor cat',
          output_path: join(tempDir!, 'generated.webp'),
          output_compression: 80,
          action: 'generate',
          input_fidelity: 'high',
        },
        'webp',
        'gpt-5.6-terra',
      )
    const tool = body.tools[0] as Record<string, unknown>

    expect(tool.output_compression).toBe(80)
    expect(tool.action).toBe('generate')
    expect(tool.input_fidelity).toBe('high')
  })

  test('defaults Codex action to auto without a reference image', () => {
    const body =
      _generateImageToolInternalsForTest.buildCodexImageGenerationBody(
        {
          prompt: 'a watercolor cat',
          output_path: join(tempDir!, 'generated.png'),
        },
        'png',
        'gpt-5.6-terra',
      )
    const tool = body.tools[0] as Record<string, unknown>

    expect(tool.action).toBe('auto')
  })

  test('defaults Codex action to edit with a reference image', () => {
    const body =
      _generateImageToolInternalsForTest.buildCodexImageGenerationBody(
        {
          prompt: 'a watercolor cat',
          output_path: join(tempDir!, 'generated.png'),
          reference_image_path: join(tempDir!, 'reference.png'),
        },
        'png',
        'gpt-5.6-terra',
        {
          imageUrl: 'data:image/png;base64,cmVmZXJlbmNl',
        },
      )
    const tool = body.tools[0] as Record<string, unknown>

    expect(tool.action).toBe('edit')
  })

  test('rejects output compression for PNG output', async () => {
    const validation = await GenerateImageTool.validateInput?.(
      {
        prompt: 'a watercolor cat',
        output_path: join(tempDir!, 'generated.png'),
        output_compression: 80,
      },
      {} as ToolUseContext,
    )

    expect(validation).toEqual({
      result: false,
      message: 'output_compression is only supported for jpeg and webp output.',
      errorCode: 8,
    })
  })

  test('includes a reference image in Codex Responses requests', () => {
    const body =
      _generateImageToolInternalsForTest.buildCodexImageGenerationBody(
        {
          prompt: 'a watercolor cat',
          output_path: join(tempDir!, 'generated.png'),
          reference_image_path: join(tempDir!, 'reference.png'),
        },
        'png',
        'gpt-5.6-terra',
        {
          imageUrl: 'data:image/png;base64,cmVmZXJlbmNl',
        },
      )

    expect(body.input[0]?.content).toEqual([
      { type: 'input_text', text: 'a watercolor cat' },
      {
        type: 'input_image',
        image_url: 'data:image/png;base64,cmVmZXJlbmNl',
      },
    ])
  })

  test('uses the subagent lease account for Codex image requests', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount('main-account'),
        buildPoolAccount('lease-account'),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-123',
      ownerType: 'subagent',
      ownerLabel: 'Patch 7 worker',
      accountId: 'lease-account',
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    let authorization: string | null = null
    let accountId: string | null = null

    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      authorization = headers.get('authorization')
      accountId = headers.get('chatgpt-account-id')
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    const result = await GenerateImageTool.call(
      {
        prompt: 'generate with the leased account',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        agentId: 'subagent-123',
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(authorization).toBe('Bearer access-lease-account')
    expect(accountId).toBe('lease-account')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
    expect(result.data.filePath).toBe(outputPath)
  })

  test('uses Codex auth when both Codex pool and OPENAI_API_KEY are available without forced backend', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount('main-account'),
        buildPoolAccount('backup-account'),
      ],
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    let requestUrl: string | undefined
    let authorization: string | null = null
    let accountId: string | null = null

    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      const headers = new Headers(init?.headers)
      authorization = headers.get('authorization')
      accountId = headers.get('chatgpt-account-id')
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    const result = await GenerateImageTool.call(
      {
        prompt: 'prefer codex when available',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(requestUrl).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(authorization).toBe('Bearer access-main-account')
    expect(accountId).toBe('main-account')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
    expect(result.data.filePath).toBe(outputPath)
  })

  test('fails over the main lease after a Codex image endpoint 429', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY
    seedCodexAccountPoolForTest({
      activeAccountId: 'primary-account',
      accounts: [
        buildPoolAccount('primary-account'),
        buildPoolAccount('backup-account'),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'primary-account',
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    const requestAccounts: string[] = []
    globalThis.fetch = (async (_input, init) => {
      requestAccounts.push(
        new Headers(init?.headers).get('chatgpt-account-id') ?? '',
      )
      if (requestAccounts.length === 1) {
        return new Response('rate limited', { status: 429 })
      }
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    await GenerateImageTool.call(
      {
        prompt: 'retry after a subscription cap',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(requestAccounts).toEqual(['primary-account', 'backup-account'])
    expect(
      getPoolStatus().accounts.find(
        account => account.accountId === 'primary-account',
      )?.status,
    ).toBe('capped')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
  })

  test('fails over only the subagent lease after a Codex image endpoint 429', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount('main-account'),
        buildPoolAccount('subagent-account'),
        buildPoolAccount('backup-account'),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'main-account',
    })
    seedCodexLeaseForTest({
      ownerId: 'image-agent',
      ownerType: 'subagent',
      ownerLabel: 'Image agent',
      accountId: 'subagent-account',
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    const requestAccounts: string[] = []
    globalThis.fetch = (async (_input, init) => {
      requestAccounts.push(
        new Headers(init?.headers).get('chatgpt-account-id') ?? '',
      )
      if (requestAccounts.length === 1) {
        return new Response('rate limited', { status: 429 })
      }
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    await GenerateImageTool.call(
      {
        prompt: 'retry without moving the main lease',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        agentId: 'image-agent',
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(requestAccounts).toEqual(['subagent-account', 'backup-account'])
    expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('main-account')
    expect(getCodexLeaseForOwner('image-agent')?.accountId).toBe('backup-account')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
  })

  test('leases an account for a subagent that arrives without one, so a 429 does not rotate the pool', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount('main-account'),
        buildPoolAccount('second-account'),
        buildPoolAccount('third-account'),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'main-account',
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    const requestAccounts: string[] = []
    globalThis.fetch = (async (_input, init) => {
      requestAccounts.push(
        new Headers(init?.headers).get('chatgpt-account-id') ?? '',
      )
      if (requestAccounts.length === 1) {
        return new Response('rate limited', { status: 429 })
      }
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    await GenerateImageTool.call(
      {
        prompt: 'generate from an Anthropic-model worker',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        agentId: 'unleased-agent',
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    const lease = getCodexLeaseForOwner('unleased-agent')
    expect(lease?.ownerType).toBe('subagent')
    expect(requestAccounts).toHaveLength(2)
    // The retry followed the worker's own lease, not the pool's active account.
    expect(lease?.accountId).toBe(requestAccounts[1]!)
    expect(requestAccounts[1]).not.toBe(requestAccounts[0])
    const pool = getPoolStatus()
    expect(pool.accounts[pool.activeIndex]?.accountId).toBe('main-account')
    expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('main-account')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
  })

  test('fails over the main lease after a Codex image endpoint 401 without a refresh token', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY
    seedCodexAccountPoolForTest({
      activeAccountId: 'primary-account',
      accounts: [
        { ...buildPoolAccount('primary-account'), refreshToken: '' },
        buildPoolAccount('backup-account'),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'primary-account',
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    const requestAccounts: string[] = []
    globalThis.fetch = (async (_input, init) => {
      requestAccounts.push(
        new Headers(init?.headers).get('chatgpt-account-id') ?? '',
      )
      if (requestAccounts.length === 1) {
        return new Response('unauthorized', { status: 401 })
      }
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    await GenerateImageTool.call(
      {
        prompt: 'retry after subscription auth failure',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(requestAccounts).toEqual(['primary-account', 'backup-account'])
    expect(
      getPoolStatus().accounts.find(
        account => account.accountId === 'primary-account',
      )?.status,
    ).toBe('dead')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
  })

  test('retries a Codex image request with the refreshed account token after a 401', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY

    const accountId = 'ca11ab1e-0000-4000-8000-00000000f102'
    const oldAccessToken = mintAccessJwt(accountId, 0)
    const newAccessToken = mintAccessJwt(accountId, 1)
    const oldRefreshToken = 'image-refresh-old'
    const newRefreshToken = 'image-refresh-new'
    const vaultFilePath = join(tempDir!, 'vault', 'accounts', `${accountId}.json`)
    await mkdir(dirname(vaultFilePath), { recursive: true })
    await writeFile(
      vaultFilePath,
      `${JSON.stringify({
        version: 1,
        tokens: {
          access_token: oldAccessToken,
          refresh_token: oldRefreshToken,
          account_id: accountId,
          expires_at: Date.now() + 3_600_000,
        },
        refresh: { state: 'idle' },
      })}\n`,
    )
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        {
          accountId,
          accessToken: oldAccessToken,
          refreshToken: oldRefreshToken,
          expiresAt: Date.now() + 3_600_000,
          source: 'vault',
          status: 'healthy',
          lastUsedAt: 0,
          vaultFilePath,
        },
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId,
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    const requestTokens: string[] = []
    let refreshCalls = 0
    globalThis.fetch = (async (input, init) => {
      const requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (requestUrl === 'https://auth.openai.com/oauth/token') {
        refreshCalls += 1
        return Response.json({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          id_token: newAccessToken,
          expires_in: 3600,
        })
      }

      requestTokens.push(
        new Headers(init?.headers).get('authorization') ?? '',
      )
      if (requestTokens.length === 1) {
        return new Response('unauthorized', { status: 401 })
      }
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    await GenerateImageTool.call(
      {
        prompt: 'retry after refreshing image credentials',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(refreshCalls).toBe(1)
    expect(requestTokens).toEqual([
      `Bearer ${oldAccessToken}`,
      `Bearer ${newAccessToken}`,
    ])
    expect(await readFile(outputPath)).toEqual(generatedBytes)
  })

  test('keeps API-key image endpoint 429 isolated from the Codex pool', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'primary-account',
      accounts: [
        buildPoolAccount('primary-account'),
        buildPoolAccount('backup-account'),
      ],
    })
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('rate limited', { status: 429 })
    }) as typeof fetch

    await expect(
      GenerateImageTool.call(
        {
          prompt: 'do not retry API-key requests',
          output_path: join(tempDir!, 'generated.png'),
        },
        {
          abortController: new AbortController(),
        } as ToolUseContext,
      ),
    ).rejects.toThrow('OpenAI image generation failed (429)')

    expect(requests).toBe(1)
    expect(getPoolStatus().accounts.map(account => account.status)).toEqual([
      'healthy',
      'healthy',
    ])
  })

  test('refreshes a near-expiry sole vault-backed Codex account through the vault for image auth', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY

    const accountId = 'ca11ab1e-0000-4000-8000-00000000f101'
    const oldAccessToken = mintAccessJwt(accountId, 0)
    const newAccessToken = mintAccessJwt(accountId, 1)
    const oldRefreshToken = 'image-refresh-old'
    const newRefreshToken = 'image-refresh-new'
    const expiredAt = Date.now() - 10_000
    const vaultFilePath = join(tempDir!, 'vault', 'accounts', `${accountId}.json`)
    await mkdir(dirname(vaultFilePath), { recursive: true })
    await writeFile(
      vaultFilePath,
      `${JSON.stringify(
        {
          version: 1,
          tokens: {
            access_token: oldAccessToken,
            refresh_token: oldRefreshToken,
            account_id: accountId,
            expires_at: expiredAt,
          },
          refresh: { state: 'idle' },
        },
        null,
        2,
      )}\n`,
    )

    saveCodexOAuthTokens({
      accessToken: oldAccessToken,
      refreshToken: oldRefreshToken,
      expiresAt: expiredAt,
      accountId,
    })
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        {
          accountId,
          accessToken: oldAccessToken,
          refreshToken: oldRefreshToken,
          expiresAt: expiredAt,
          source: 'vault',
          status: 'healthy',
          lastUsedAt: 0,
          vaultFilePath,
        },
      ],
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    let refreshCalls = 0
    let authorization: string | null = null
    let requestAccountId: string | null = null

    globalThis.fetch = (async (input, init) => {
      const requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (requestUrl === 'https://auth.openai.com/oauth/token') {
        refreshCalls += 1
        const body = JSON.parse(String(init?.body)) as { refresh_token?: string }
        expect(body.refresh_token).toBe(oldRefreshToken)
        return Response.json({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          id_token: newAccessToken,
          expires_in: 3600,
        })
      }

      if (requestUrl === 'https://chatgpt.com/backend-api/codex/responses') {
        const headers = new Headers(init?.headers)
        authorization = headers.get('authorization')
        requestAccountId = headers.get('chatgpt-account-id')
        return new Response(
          [
            'event: response.output_item.done',
            `data: ${JSON.stringify({
              type: 'response.output_item.done',
              item: {
                type: 'image_generation_call',
                result: generatedBytes.toString('base64'),
              },
            })}`,
            '',
          ].join('\n'),
          { status: 200 },
        )
      }

      throw new Error(`Unexpected fetch in image auth refresh test: ${requestUrl}`)
    }) as typeof fetch

    const result = await GenerateImageTool.call(
      {
        prompt: 'refresh through vault before image generation',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    const savedVault = JSON.parse(await readFile(vaultFilePath, 'utf8')) as {
      tokens?: {
        access_token?: string
        refresh_token?: string
        account_id?: string
        expires_at?: number
      }
      refresh?: { state?: string }
    }

    expect(refreshCalls).toBe(1)
    expect(authorization).toBe(`Bearer ${newAccessToken}`)
    expect(requestAccountId).toBe(accountId)
    expect(savedVault.tokens?.access_token).toBe(newAccessToken)
    expect(savedVault.tokens?.refresh_token).toBe(newRefreshToken)
    expect(savedVault.tokens?.account_id).toBe(accountId)
    expect(savedVault.tokens?.expires_at).toBeGreaterThan(Date.now())
    expect(savedVault.refresh?.state).toBe('idle')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
    expect(result.data.filePath).toBe(outputPath)
  })

  test('uses the main-thread lease account for Codex image requests', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount('main-account'),
        buildPoolAccount('lease-account'),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'lease-account',
    })

    const outputPath = join(tempDir!, 'generated.png')
    const generatedBytes = Buffer.from('generated image')
    let authorization: string | null = null
    let accountId: string | null = null

    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      authorization = headers.get('authorization')
      accountId = headers.get('chatgpt-account-id')
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    const result = await GenerateImageTool.call(
      {
        prompt: 'generate with the main lease',
        output_path: outputPath,
      },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(authorization).toBe('Bearer access-lease-account')
    expect(accountId).toBe('lease-account')
    expect(await readFile(outputPath)).toEqual(generatedBytes)
    expect(result.data.filePath).toBe(outputPath)
  })

  test('sends reference image files through the Codex backend', async () => {
    delete process.env.CAT_CODE_IMAGE_BACKEND
    delete process.env.OPENAI_API_KEY
    seedCodexAccountPoolForTest({
      activeAccountId: 'main-account',
      accounts: [
        buildPoolAccount('main-account'),
        buildPoolAccount('backup-account'),
      ],
    })

    const outputPath = join(tempDir!, 'generated.png')
    const referencePath = join(tempDir!, 'reference.png')
    const referenceBytes = Buffer.from('reference image')
    const generatedBytes = Buffer.from('generated image')
    await writeFile(referencePath, referenceBytes)
    let requestBody: Record<string, unknown> | undefined
    let accountId: string | null = null

    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      accountId = new Headers(init?.headers).get('chatgpt-account-id')
      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'image_generation_call',
              result: generatedBytes.toString('base64'),
            },
          })}`,
          '',
        ].join('\n'),
        { status: 200 },
      )
    }) as typeof fetch

    const result = await GenerateImageTool.call(
      {
        prompt: 'use this reference',
        output_path: outputPath,
        reference_image_path: referencePath,
      },
      {
        abortController: new AbortController(),
        options: { mainLoopModel: 'gpt-5.6-terra' },
      } as ToolUseContext,
    )

    expect(accountId).toBe('main-account')
    expect(requestBody?.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'use this reference' },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${referenceBytes.toString('base64')}`,
          },
        ],
      },
    ])
    expect(await readFile(outputPath)).toEqual(generatedBytes)
    expect(result.data.filePath).toBe(outputPath)
  })

  test('rejects missing reference image paths', async () => {
    const validation = await GenerateImageTool.validateInput?.(
      {
        prompt: 'a watercolor cat',
        output_path: join(tempDir!, 'generated.png'),
        reference_image_path: join(tempDir!, 'missing.png'),
      },
      {} as ToolUseContext,
    )

    expect(validation).toEqual({
      result: false,
      message: 'reference_image_path does not exist.',
      errorCode: 7,
    })
  })

  test('prompt instructs callers not to rewrite image prompts by default', async () => {
    const prompt = await GenerateImageTool.prompt({
      getToolPermissionContext: async () => ({} as never),
      tools: [],
      agents: [],
    })

    expect(prompt).toContain(
      "Pass the user's requested image prompt exactly as prompt",
    )
    expect(prompt).toContain('Do not rewrite, expand, stylize, or add details')
    expect(prompt).toContain(
      'This uploads the image to the image-generation backend',
    )
  })

  test('parses Codex Responses image-generation SSE output', () => {
    const imageBytes = Buffer.from('generated image')
    const b64 = imageBytes.toString('base64')
    const sse = [
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          result: b64,
        },
      })}`,
      '',
    ].join('\n')

    expect(
      _generateImageToolInternalsForTest.parseCodexImageGenerationResponse(sse),
    ).toBe(b64)
  })

  test('parses Codex image data URLs from streamed output', () => {
    const imageBytes = Buffer.from('generated image')
    const b64 = imageBytes.toString('base64')
    const sse = [
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'image_generation_call',
          image_url: `data:image/png;base64,${b64}`,
        },
      })}`,
      '',
    ].join('\n')

    expect(
      _generateImageToolInternalsForTest.parseCodexImageGenerationResponse(sse),
    ).toBe(b64)
  })

  test('summarizes Codex responses that do not include image data', () => {
    const sse = [
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          content: [{ type: 'output_text', text: 'No image was generated.' }],
        },
      })}`,
      '',
    ].join('\n')

    expect(() =>
      _generateImageToolInternalsForTest.parseCodexImageGenerationResponse(sse),
    ).toThrow(
      'Codex image generation did not return base64 image data (bytes=',
    )
    expect(() =>
      _generateImageToolInternalsForTest.parseCodexImageGenerationResponse(sse),
    ).toThrow('events=response.output_item.done,message,output_text')
    expect(() =>
      _generateImageToolInternalsForTest.parseCodexImageGenerationResponse(sse),
    ).toThrow('items=message')
  })

  test('builds an ANSI terminal preview for generated images', async () => {
    const { PNG } = await import('pngjs')
    const { writeFileSync } = await import('fs')
    const outputPath = join(tempDir!, 'preview.png')
    const png = new PNG({ width: 2, height: 2 })
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255
      png.data[i + 1] = 0
      png.data[i + 2] = 0
      png.data[i + 3] = 255
    }
    writeFileSync(outputPath, PNG.sync.write(png))

    const preview =
      await _generateImageToolInternalsForTest.buildTerminalImagePreview(
        outputPath,
      )

    expect(preview?.kind).toBe('ansi')
    if (preview?.kind !== 'ansi') throw new Error('expected ansi preview')
    expect(preview.width).toBe(2)
    expect(preview.lines).toHaveLength(1)
    expect(preview.lines[0]).toContain('\x1b[38;2;255;0;0m')
    expect(preview.lines[0]).toContain('▀')
  })

  test('builds a multipart iTerm2 inline image preview', () => {
    const preview =
      _generateImageToolInternalsForTest.buildIterm2InlineImage(
        Buffer.from('generated image'),
        join(tempDir!, 'preview.png'),
        48,
        16,
      )

    expect(preview.kind).toBe('iterm2')
    if (preview.kind !== 'iterm2') throw new Error('expected iterm2 preview')
    expect(preview.sequence).toStartWith(
      '\x1b]1337;MultipartFile=name=cHJldmlldy5wbmc=;size=15;width=48;height=16;preserveAspectRatio=1;inline=1;type=image/png\x07',
    )
    expect(preview.sequence).toContain(
      `\x1b]1337;FilePart=${Buffer.from('generated image').toString('base64')}\x07`,
    )
    expect(preview.sequence).toEndWith('\x1b]1337;FileEnd\x07')
  })
})
