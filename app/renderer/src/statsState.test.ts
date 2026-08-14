import { describe, expect, test } from 'bun:test'
import {
  computeChartSeries,
  computeModelBreakdown,
  formatDateLabel,
  formatModelDisplayName,
  formatTokens,
  getModelColor,
} from './statsState.js'

describe('statsState', () => {
  test('formatTokens formats numbers into readable magnitudes', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-50)).toBe('0')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(45600)).toBe('45.6k')
    expect(formatTokens(2260000)).toBe('2.26M')
    expect(formatTokens(15400000)).toBe('15.4M')
  })

  test('formatDateLabel formats YYYY-MM-DD into short month + day', () => {
    expect(formatDateLabel('2026-08-14')).toBe('Aug 14')
    expect(formatDateLabel('2026-01-01')).toBe('Jan 1')
    expect(formatDateLabel('invalid')).toBe('invalid')
  })

  test('formatModelDisplayName maps canonical IDs to human titles', () => {
    expect(formatModelDisplayName('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet')
    expect(formatModelDisplayName('claude-3-opus-20240229')).toBe('Claude 3 Opus')
    expect(formatModelDisplayName('gpt-4o')).toBe('GPT-4o')
    expect(formatModelDisplayName('custom-model')).toBe('custom-model')
  })

  test('getModelColor provides distinct colors for known models', () => {
    const sonnetColor = getModelColor('claude-3-5-sonnet')
    const gptColor = getModelColor('gpt-4o')
    expect(sonnetColor).toBe('#d97706')
    expect(gptColor).toBe('#0284c7')
  })

  test('computeChartSeries processes dailyModelTokens into aligned arrays', () => {
    const raw = [
      {
        date: '2026-08-13',
        tokensByModel: {
          'claude-3-5-sonnet': 10000,
          'claude-3-opus': 5000,
        },
      },
      {
        date: '2026-08-14',
        tokensByModel: {
          'claude-3-5-sonnet': 20000,
          'claude-3-opus': 10000,
        },
      },
    ]

    const chart = computeChartSeries(raw)
    expect(chart.dates).toEqual(['2026-08-13', '2026-08-14'])
    expect(chart.displayDates).toEqual(['Aug 13', 'Aug 14'])
    expect(chart.series).toHaveLength(2)
    expect(chart.series[0]?.name).toBe('claude-3-5-sonnet')
    expect(chart.series[0]?.values).toEqual([10000, 20000])
    expect(chart.series[1]?.name).toBe('claude-3-opus')
    expect(chart.series[1]?.values).toEqual([5000, 10000])
    expect(chart.maxDailyTotal).toBe(30000)
    expect(chart.totalWindowTokens).toBe(45000)
  })

  test('computeModelBreakdown computes sorted percentages', () => {
    const modelUsage = {
      'claude-3-5-sonnet': {
        inputTokens: 30000,
        outputTokens: 10000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      'gpt-4o': {
        inputTokens: 10000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    }

    const breakdown = computeModelBreakdown(modelUsage)
    expect(breakdown).toHaveLength(2)
    expect(breakdown[0]?.modelName).toBe('claude-3-5-sonnet')
    expect(breakdown[0]?.totalTokens).toBe(40000)
    expect(breakdown[0]?.percentage).toBe(80)
    expect(breakdown[1]?.modelName).toBe('gpt-4o')
    expect(breakdown[1]?.totalTokens).toBe(10000)
    expect(breakdown[1]?.percentage).toBe(20)
  })
})
