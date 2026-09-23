import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { executeEffort, showCurrentEffort } from '../../commands/effort/effort.js'
import { cycleEffortLevel } from '../../components/ModelPicker.js'
import { CODEX_MODELS } from '../../services/api/codex-fetch-adapter.js'
import { getContextWindowForModel } from '../context.js'
import {
  getDefaultEffortForModel,
  getEffortLevelLabel,
  getEffortSuffix,
  getSupportedEffortLevels,
  modelSupportsMaxEffort,
} from '../effort.js'
import { getAgentModelOptions } from './agent.js'
import {
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} from './model.js'

describe('GPT retirement replacements', () => {
  test('replaces every retired GPT selection with its designated successor model', () => {
    expect(parseUserSpecifiedModel('gpt-5.6-sol')).toBe('gpt-6-sol')
    expect(parseUserSpecifiedModel('gpt-5.6-luna')).toBe('gpt-6-luna')
    expect(parseUserSpecifiedModel('gpt-5.4')).toBe('gpt-6-luna')
    expect(parseUserSpecifiedModel('gpt-5.3-codex')).toBe('gpt-6-luna')
    expect(parseUserSpecifiedModel('gpt-5.4-mini')).toBe('gpt-6-luna')
    expect(parseUserSpecifiedModel('gpt-5.5')).toBe('gpt-5.6-terra')

    for (const retiredModel of [
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.4-mini',
      'gpt-5.5',
    ]) {
      expect(
        getAgentModelOptions().some(option => option.value === retiredModel),
      ).toBe(false)
      expect(CODEX_MODELS.some(model => model.id === retiredModel)).toBe(false)
    }

    const optionSource = readFileSync(
      new URL('./modelOptions.ts', import.meta.url),
      'utf8',
    )
    expect(optionSource).not.toContain("value: 'gpt-5.6-sol'")
    expect(optionSource).not.toContain("value: 'gpt-5.6-luna'")
    expect(optionSource).not.toContain('gpt-5.4')
    expect(optionSource).not.toContain('gpt-5.3-codex')
    expect(optionSource).not.toContain('gpt-5.5')
  })
})

describe('Active GPT models: Astra, Sol, Terra, Luna', () => {
  const activeModels = [
    {
      id: 'gpt-6-astra',
      publicDisplay: 'GPT 6 Astra',
      marketingName: 'GPT-6 Astra',
      window: 1_050_000,
      defaultEffort: undefined,
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'gpt-6-sol',
      publicDisplay: 'GPT 6 Sol',
      marketingName: 'GPT-6 Sol',
      window: 1_050_000,
      defaultEffort: 'medium',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'gpt-5.6-terra',
      publicDisplay: 'GPT 5.6 Terra',
      marketingName: 'GPT-5.6 Terra',
      window: 372_000,
      defaultEffort: 'medium',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      id: 'gpt-6-luna',
      publicDisplay: 'GPT 6 Luna',
      marketingName: 'GPT-6 Luna',
      window: 1_050_000,
      defaultEffort: 'low',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ] as const

  for (const item of activeModels) {
    test(`${item.marketingName} is selectable and uses its configured limits`, () => {
      expect(getPublicModelDisplayName(item.id)).toBe(item.publicDisplay)
      expect(getMarketingNameForModel(item.id)).toBe(item.marketingName)
      expect(
        getAgentModelOptions().find(option => option.value === item.id)?.label,
      ).toBe(item.marketingName)
      expect(CODEX_MODELS.find(entry => entry.id === item.id)?.label).toBe(
        item.marketingName,
      )
      expect(getContextWindowForModel(item.id)).toBe(item.window)
      expect(getDefaultEffortForModel(item.id)).toBe(item.defaultEffort)
      expect(modelSupportsMaxEffort(item.id)).toBe(true)
      expect(getSupportedEffortLevels(item.id)).toEqual(
        item.supportedEfforts as readonly string[],
      )
    })
  }

  test('picker order is Astra -> Sol -> Terra -> Luna', () => {
    const agentModels = getAgentModelOptions().map(option => option.value)
    const astraIdx = agentModels.indexOf('gpt-6-astra')
    const solIdx = agentModels.indexOf('gpt-6-sol')
    const terraIdx = agentModels.indexOf('gpt-5.6-terra')
    const lunaIdx = agentModels.indexOf('gpt-6-luna')

    expect(astraIdx).toBeGreaterThanOrEqual(0)
    expect(solIdx).toBe(astraIdx + 1)
    expect(terraIdx).toBe(solIdx + 1)
    expect(lunaIdx).toBe(terraIdx + 1)

    const codexModels = CODEX_MODELS.map(entry => entry.id)
    const cAstraIdx = codexModels.indexOf('gpt-6-astra')
    const cSolIdx = codexModels.indexOf('gpt-6-sol')
    const cTerraIdx = codexModels.indexOf('gpt-5.6-terra')
    const cLunaIdx = codexModels.indexOf('gpt-6-luna')

    expect(cAstraIdx).toBeGreaterThanOrEqual(0)
    expect(cSolIdx).toBe(cAstraIdx + 1)
    expect(cTerraIdx).toBe(cSolIdx + 1)
    expect(cLunaIdx).toBe(cTerraIdx + 1)
  })

  test('uses Codex CLI reasoning labels', () => {
    expect(getEffortLevelLabel('xhigh')).toBe('Extra high')
    expect(getEffortLevelLabel('max')).toBe('Max')
    expect(getEffortLevelLabel('ultra')).toBe('Ultra')
    expect(getEffortSuffix('gpt-6-sol', 'xhigh')).toBe(' with extra high effort')
  })

  test('cycles through reasoning levels according to model support', () => {
    const solLevels = getSupportedEffortLevels('gpt-6-sol')
    expect(cycleEffortLevel('high', 'right', solLevels)).toBe('xhigh')
    expect(cycleEffortLevel('xhigh', 'right', solLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', solLevels)).toBe('low')

    const terraLevels = getSupportedEffortLevels('gpt-5.6-terra')
    expect(cycleEffortLevel('high', 'right', terraLevels)).toBe('xhigh')
    expect(cycleEffortLevel('xhigh', 'right', terraLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', terraLevels)).toBe('ultra')
    expect(cycleEffortLevel('ultra', 'right', terraLevels)).toBe('low')

    const lunaLevels = getSupportedEffortLevels('gpt-6-luna')
    expect(cycleEffortLevel('xhigh', 'right', lunaLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', lunaLevels)).toBe('low')
  })

  test('/effort accepts supported levels and reports labels', () => {
    expect(executeEffort('XHIGH', 'gpt-6-sol')).toMatchObject({
      effortUpdate: { value: 'xhigh' },
      message: expect.stringContaining('Extra high'),
    })
    expect(executeEffort('MAX', 'gpt-6-sol')).toMatchObject({
      effortUpdate: { value: 'max' },
      message: expect.stringContaining('Max'),
    })
    // GPT-6 Sol does not support ultra
    expect(executeEffort('ULTRA', 'gpt-6-sol')).toEqual({
      message:
        'Effort ultra is not supported by gpt-6-sol. Valid options are: low, medium, high, xhigh, max, auto',
    })
    // GPT-5.6 Terra supports ultra
    expect(executeEffort('ULTRA', 'gpt-5.6-terra')).toMatchObject({
      effortUpdate: { value: 'ultra' },
      message: expect.stringContaining('Ultra'),
    })
    expect(showCurrentEffort('xhigh', 'gpt-6-sol').message).toContain('Extra high')
  })

  test('shows active GPT tiers in the main picker source', () => {
    const source = readFileSync(new URL('./modelOptions.ts', import.meta.url), 'utf8')
    expect(source).toContain("value: 'gpt-6-astra'")
    expect(source).toContain("value: 'gpt-6-sol'")
    expect(source).toContain("value: 'gpt-5.6-terra'")
    expect(source).toContain("value: 'gpt-6-luna'")
  })
})
