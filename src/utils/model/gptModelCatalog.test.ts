import { describe, expect, test } from 'bun:test'

import { executeEffort, showCurrentEffort } from '../../commands/effort/effort.js'
import { cycleEffortLevel } from '../../components/ModelPicker.js'
import { getContextWindowForModel } from '../context.js'
import {
  getDefaultEffortForModel,
  getEffortLevelLabel,
  getEffortSuffix,
  getSupportedEffortLevels,
  modelSupportsMaxEffort,
} from '../effort.js'
import { getAgentModelOptions } from './agent.js'
import { currentCodexRelease, isRoutableCodexModelId } from './configs.js'
import {
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} from './model.js'

const families = ['astra', 'sol', 'terra', 'luna'] as const

describe('Codex selection', () => {
  test('replaces every retired GPT selection with its designated successor model', () => {
    const retiredByFamily = {
      astra: ['gpt-6-astra', 'gpt-6.1-astra'],
      sol: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'],
      terra: ['gpt-5.5', 'gpt-5.6-terra'],
      luna: ['gpt-5.6-luna', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini'],
    }
    const choices = getAgentModelOptions().map(option => option.value)
    for (const family of families) {
      const current = currentCodexRelease(family).id
      for (const retired of retiredByFamily[family]) {
        expect(parseUserSpecifiedModel(retired)).toBe(current)
        expect(choices).not.toContain(retired)
        expect(isRoutableCodexModelId(retired)).toBe(false)
      }
    }
    expect(parseUserSpecifiedModel(' GPT-6.1-ASTRA[1m] ')).toBe(currentCodexRelease('astra').id)
    expect(parseUserSpecifiedModel(' GPT-5.6-TERRA[1m] ')).toBe(currentCodexRelease('terra').id)
  })

  test('offers the current releases in Astra, Sol, Terra, Luna order', () => {
    const expected = families.map(family => {
      const { id, label } = currentCodexRelease(family)
      expect(isRoutableCodexModelId(id)).toBe(true)
      return { value: id, label }
    })
    const choices = getAgentModelOptions().map(({ value, label }) => ({ value, label }))
    const start = choices.findIndex(choice => choice.value === expected[0]!.value)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(choices.slice(start, start + expected.length)).toEqual(expected)
  })
})

describe('Exact Codex release facts', () => {
  const releases = [
    {
      id: 'gpt-6.2-astra',
      publicDisplay: 'GPT 6.2 Astra',
      marketingName: 'GPT-6.2 Astra',
      window: 500_000,
      defaultEffort: undefined,
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      id: 'gpt-6.2-sol',
      publicDisplay: 'GPT 6.2 Sol',
      marketingName: 'GPT-6.2 Sol',
      window: 500_000,
      defaultEffort: 'medium',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      id: 'gpt-6.1-terra',
      publicDisplay: 'GPT 6.1 Terra',
      marketingName: 'GPT-6.1 Terra',
      window: 1_050_000,
      defaultEffort: 'medium',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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

  for (const item of releases) {
    test(`${item.marketingName} retains its labels and limits`, () => {
      expect(getPublicModelDisplayName(item.id)).toBe(item.publicDisplay)
      expect(getMarketingNameForModel(item.id)).toBe(item.marketingName)
      expect(getContextWindowForModel(item.id)).toBe(item.window)
      expect(getDefaultEffortForModel(item.id)).toBe(item.defaultEffort)
      expect(modelSupportsMaxEffort(item.id)).toBe(true)
      expect(getSupportedEffortLevels(item.id)).toEqual(
        item.supportedEfforts as readonly string[],
      )
    })
  }

  test('uses Codex CLI reasoning labels', () => {
    expect(getEffortLevelLabel('xhigh')).toBe('Extra high')
    expect(getEffortLevelLabel('max')).toBe('Max')
    expect(getEffortLevelLabel('ultra')).toBe('Ultra')
    expect(getEffortSuffix('gpt-6.2-sol', 'xhigh')).toBe(' with extra high effort')
  })

  test('cycles through reasoning levels according to model support', () => {
    const solLevels = getSupportedEffortLevels('gpt-6.2-sol')
    expect(cycleEffortLevel('high', 'right', solLevels)).toBe('xhigh')
    expect(cycleEffortLevel('xhigh', 'right', solLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', solLevels)).toBe('ultra')
    expect(cycleEffortLevel('ultra', 'right', solLevels)).toBe('low')

    const terraLevels = getSupportedEffortLevels('gpt-6.1-terra')
    expect(cycleEffortLevel('high', 'right', terraLevels)).toBe('xhigh')
    expect(cycleEffortLevel('xhigh', 'right', terraLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', terraLevels)).toBe('low')

    const lunaLevels = getSupportedEffortLevels('gpt-6-luna')
    expect(cycleEffortLevel('xhigh', 'right', lunaLevels)).toBe('max')
    expect(cycleEffortLevel('max', 'right', lunaLevels)).toBe('low')
  })

  test('/effort accepts supported levels and reports labels', () => {
    expect(executeEffort('XHIGH', 'gpt-6.2-sol')).toMatchObject({
      effortUpdate: { value: 'xhigh' },
      message: expect.stringContaining('Extra high'),
    })
    expect(executeEffort('MAX', 'gpt-6.2-sol')).toMatchObject({
      effortUpdate: { value: 'max' },
      message: expect.stringContaining('Max'),
    })
    expect(executeEffort('ULTRA', 'gpt-6.2-sol')).toMatchObject({
      effortUpdate: { value: 'ultra' },
      message: expect.stringContaining('Ultra'),
    })
    expect(executeEffort('ULTRA', 'gpt-6.1-terra')).toEqual({
      message:
        'Effort ultra is not supported by gpt-6.1-terra. Valid options are: low, medium, high, xhigh, max, auto',
    })
    expect(showCurrentEffort('xhigh', 'gpt-6.2-sol').message).toContain('Extra high')
  })
})
