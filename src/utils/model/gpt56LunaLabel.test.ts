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
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} from './model.js'

describe('GPT-5.6 retirement replacements', () => {
  test('replaces every retired GPT selection with its designated GPT-5.6 model', () => {
    for (const retiredModel of [
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.4-mini',
    ]) {
      expect(parseUserSpecifiedModel(retiredModel)).toBe('gpt-5.6-luna')
      expect(
        getAgentModelOptions().some(option => option.value === retiredModel),
      ).toBe(false)
      expect(CODEX_MODELS.some(model => model.id === retiredModel)).toBe(false)
    }
    expect(parseUserSpecifiedModel('gpt-5.5')).toBe('gpt-5.6-terra')
    expect(getAgentModelOptions().some(option => option.value === 'gpt-5.5')).toBe(false)
    expect(CODEX_MODELS.some(model => model.id === 'gpt-5.5')).toBe(false)

    const optionSource = readFileSync(
      new URL('./modelOptions.ts', import.meta.url),
      'utf8',
    )
    expect(optionSource).not.toContain('gpt-5.4')
    expect(optionSource).not.toContain('gpt-5.3-codex')
    expect(optionSource).not.toContain('gpt-5.5')
  })
})

describe('GPT-5.6 Sol, Terra, and Luna', () => {
  for (const [model, label] of [
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ] as const) {
    test(`${label} is selectable and uses its configured Codex limits`, () => {
      expect(getPublicModelDisplayName(model)).toBe(label.replace('-', ' '))
      expect(getAgentModelOptions().find(option => option.value === model)?.label).toBe(label)
      expect(CODEX_MODELS.find(entry => entry.id === model)?.label).toBe(label)
      // Sol runs Codex's 1M window; Terra and Luna stay on 372k.
      expect(getContextWindowForModel(model)).toBe(
        model === 'gpt-5.6-sol' ? 1_000_000 : 372_000,
      )
      expect(getDefaultEffortForModel(model)).toBe(
        model === 'gpt-5.6-luna' ? 'low' : 'medium',
      )
      expect(modelSupportsMaxEffort(model)).toBe(true)
      expect(getSupportedEffortLevels(model)).toEqual(
        model === 'gpt-5.6-luna'
          ? ['low', 'medium', 'high', 'xhigh', 'max']
          : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      )
    })
  }

  test('uses Codex CLI reasoning labels', () => {
    expect(getEffortLevelLabel('xhigh')).toBe('Extra high')
    expect(getEffortLevelLabel('max')).toBe('Max')
    expect(getEffortLevelLabel('ultra')).toBe('Ultra')
    expect(getEffortSuffix('gpt-5.6-sol', 'xhigh')).toBe(
      ' with extra high effort',
    )
  })

  test('cycles through each model’s advertised reasoning levels', () => {
    const solLevels = getSupportedEffortLevels('gpt-5.6-sol')
    expect(cycleEffortLevel('high', 'right', solLevels)).toBe('xhigh')
    expect(cycleEffortLevel('xhigh', 'right', solLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', solLevels)).toBe('ultra')

    const lunaLevels = getSupportedEffortLevels('gpt-5.6-luna')
    expect(cycleEffortLevel('xhigh', 'right', lunaLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', lunaLevels)).toBe('low')
  })

  test('/effort accepts Codex levels and reports their labels', () => {
    expect(executeEffort('XHIGH', 'gpt-5.6-sol')).toMatchObject({
      effortUpdate: { value: 'xhigh' },
      message: expect.stringContaining('Extra high'),
    })
    expect(executeEffort('ULTRA', 'gpt-5.6-sol')).toMatchObject({
      effortUpdate: { value: 'ultra' },
      message: expect.stringContaining('Ultra'),
    })
    expect(executeEffort('impossible', 'gpt-5.6-sol')).toEqual({
      message:
        'Invalid argument: impossible. Valid options are: low, medium, high, xhigh, max, ultra, auto',
    })
    expect(showCurrentEffort('xhigh', 'gpt-5.6-sol').message).toContain(
      'Extra high',
    )
  })

  test('shows every GPT-5.6 tier in the main picker source', () => {
    const source = readFileSync(new URL('./modelOptions.ts', import.meta.url), 'utf8')
    expect(source).toContain("value: 'gpt-5.6-sol'")
    expect(source).toContain("value: 'gpt-5.6-terra'")
    expect(source).toContain("value: 'gpt-5.6-luna'")
  })
})
