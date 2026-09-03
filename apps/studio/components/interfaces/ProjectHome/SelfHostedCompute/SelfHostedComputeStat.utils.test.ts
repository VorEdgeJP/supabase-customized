import { describe, expect, test } from 'vitest'

import {
  COMPUTE_RANGE_MINUTES,
  formatByteRatio,
  formatByteValue,
  formatCount,
  formatCountRatio,
  formatPercent,
  getComputeMetricsRange,
  getLatestValues,
  getUsagePercent,
  NO_VALUE,
  SELF_HOSTED_COMPUTE_ATTRIBUTES,
} from './SelfHostedComputeStat.utils'
import type {
  InfraMonitoringMultiResponse,
  InfraMonitoringSingleResponse,
} from '@/data/analytics/infra-monitoring-query'

const multiResponse = (
  rows: { period_start: string; values: Record<string, string | undefined> }[]
): InfraMonitoringMultiResponse => ({ data: rows, series: {} })

const singleResponse = (
  rows: { period_start: string; [attribute: string]: string | undefined }[]
): InfraMonitoringSingleResponse => ({
  data: rows,
  yAxisLimit: 100,
  format: '%',
  total: 0,
  totalAverage: 0,
})

describe('getLatestValues', () => {
  test('returns null for every attribute when there is no response', () => {
    expect(getLatestValues(undefined)).toEqual({
      avg_cpu_usage: null,
      ram_usage: null,
      ram_usage_used: null,
      ram_usage_total: null,
      disk_fs_used: null,
      disk_fs_size: null,
      pg_stat_database_num_backends: null,
      max_db_connections: null,
    })
  })

  test('returns null for every attribute when the response has no rows', () => {
    const values = getLatestValues(multiResponse([]))
    expect(Object.values(values).every((value) => value === null)).toBe(true)
  })

  test('reads the last row of a multi-attribute response', () => {
    const values = getLatestValues(
      multiResponse([
        { period_start: '2026-09-03T00:00:00Z', values: { avg_cpu_usage: '10', ram_usage: '20' } },
        { period_start: '2026-09-03T00:01:00Z', values: { avg_cpu_usage: '30', ram_usage: '40' } },
      ]),
      ['avg_cpu_usage', 'ram_usage']
    )

    expect(values).toEqual({ avg_cpu_usage: 30, ram_usage: 40 })
  })

  test('reads a single-attribute response, where values are inlined on the row', () => {
    const values = getLatestValues(
      singleResponse([
        { period_start: '2026-09-03T00:00:00Z', avg_cpu_usage: '12' },
        { period_start: '2026-09-03T00:01:00Z', avg_cpu_usage: '17.4' },
      ]),
      ['avg_cpu_usage']
    )

    expect(values).toEqual({ avg_cpu_usage: 17.4 })
  })

  test('falls back to an earlier row when the last bucket has no sample', () => {
    const values = getLatestValues(
      multiResponse([
        { period_start: '2026-09-03T00:00:00Z', values: { avg_cpu_usage: '10', ram_usage: '20' } },
        { period_start: '2026-09-03T00:01:00Z', values: { ram_usage: '40' } },
      ]),
      ['avg_cpu_usage', 'ram_usage']
    )

    expect(values).toEqual({ avg_cpu_usage: 10, ram_usage: 40 })
  })

  test('skips empty strings, nulls and non-numeric values', () => {
    const values = getLatestValues(
      multiResponse([
        { period_start: '2026-09-03T00:00:00Z', values: { avg_cpu_usage: '5', ram_usage: '9' } },
        {
          period_start: '2026-09-03T00:01:00Z',
          values: { avg_cpu_usage: '', ram_usage: 'not-a-number' },
        },
      ]),
      ['avg_cpu_usage', 'ram_usage']
    )

    expect(values).toEqual({ avg_cpu_usage: 5, ram_usage: 9 })
  })

  test('keeps zero as a reported value rather than treating it as missing', () => {
    const values = getLatestValues(
      multiResponse([
        { period_start: '2026-09-03T00:00:00Z', values: { avg_cpu_usage: '80' } },
        { period_start: '2026-09-03T00:01:00Z', values: { avg_cpu_usage: '0' } },
      ]),
      ['avg_cpu_usage']
    )

    expect(values).toEqual({ avg_cpu_usage: 0 })
  })

  test('tolerates a multi-attribute row without a values object', () => {
    const response = {
      data: [{ period_start: '2026-09-03T00:00:00Z' }],
      series: {},
    } as unknown as InfraMonitoringMultiResponse

    expect(getLatestValues(response, ['avg_cpu_usage'])).toEqual({ avg_cpu_usage: null })
  })

  test('defaults to the full attribute list', () => {
    const values = getLatestValues(
      multiResponse([
        {
          period_start: '2026-09-03T00:00:00Z',
          values: Object.fromEntries(
            SELF_HOSTED_COMPUTE_ATTRIBUTES.map((attribute) => [attribute, '1'])
          ),
        },
      ])
    )

    expect(Object.keys(values).sort()).toEqual([...SELF_HOSTED_COMPUTE_ATTRIBUTES].sort())
    expect(Object.values(values).every((value) => value === 1)).toBe(true)
  })
})

describe('formatPercent', () => {
  test('rounds to a whole percent', () => {
    expect(formatPercent(12.4)).toBe('12%')
    expect(formatPercent(12.5)).toBe('13%')
  })

  test('formats zero', () => {
    expect(formatPercent(0)).toBe('0%')
  })

  test('clamps outside the 0-100 range', () => {
    expect(formatPercent(-4)).toBe('0%')
    expect(formatPercent(140)).toBe('100%')
  })

  test('shows the placeholder for a missing or non-finite value', () => {
    expect(formatPercent(null)).toBe(NO_VALUE)
    expect(formatPercent(Number.NaN)).toBe(NO_VALUE)
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe(NO_VALUE)
  })
})

describe('formatByteValue', () => {
  test('formats byte counts', () => {
    expect(formatByteValue(0)).toBe('0 bytes')
    expect(formatByteValue(1024)).toBe('1 KB')
    expect(formatByteValue(1024 * 1024 * 1.5)).toBe('1.5 MB')
  })

  test('shows the placeholder for missing, negative or non-finite values', () => {
    expect(formatByteValue(null)).toBe(NO_VALUE)
    expect(formatByteValue(-1)).toBe(NO_VALUE)
    expect(formatByteValue(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('formatByteRatio', () => {
  test('joins both sides with a slash', () => {
    expect(formatByteRatio(1024, 4096)).toBe('1 KB / 4 KB')
  })

  test('falls back to the placeholder per side', () => {
    expect(formatByteRatio(null, 4096)).toBe(`${NO_VALUE} / 4 KB`)
    expect(formatByteRatio(1024, null)).toBe(`1 KB / ${NO_VALUE}`)
    expect(formatByteRatio(null, null)).toBe(`${NO_VALUE} / ${NO_VALUE}`)
  })
})

describe('formatCount', () => {
  test('rounds and groups counts', () => {
    expect(formatCount(7)).toBe('7')
    expect(formatCount(7.6)).toBe('8')
    expect(formatCount(1234)).toBe((1234).toLocaleString())
  })

  test('shows the placeholder for missing, negative or non-finite values', () => {
    expect(formatCount(null)).toBe(NO_VALUE)
    expect(formatCount(-2)).toBe(NO_VALUE)
    expect(formatCount(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('formatCountRatio', () => {
  test('joins both sides with a slash', () => {
    expect(formatCountRatio(5, 100)).toBe('5 / 100')
    expect(formatCountRatio(null, 100)).toBe(`${NO_VALUE} / 100`)
  })
})

describe('getUsagePercent', () => {
  test('derives a percentage from a used/total pair', () => {
    expect(getUsagePercent(50, 200)).toBe(25)
    expect(getUsagePercent(0, 200)).toBe(0)
  })

  test('returns null when either side is missing', () => {
    expect(getUsagePercent(null, 200)).toBeNull()
    expect(getUsagePercent(50, null)).toBeNull()
  })

  test('returns null for a zero or negative total rather than reporting 0%', () => {
    expect(getUsagePercent(50, 0)).toBeNull()
    expect(getUsagePercent(50, -1)).toBeNull()
  })

  test('returns null for non-finite input', () => {
    expect(getUsagePercent(Number.NaN, 200)).toBeNull()
    expect(getUsagePercent(50, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('getComputeMetricsRange', () => {
  test('aligns both ends to the minute and looks back a fixed window', () => {
    const range = getComputeMetricsRange(new Date('2026-09-03T10:07:42.123Z'))

    expect(range.endDate).toBe('2026-09-03T10:07:00.000Z')
    expect(range.startDate).toBe('2026-09-03T10:02:00.000Z')
  })

  test('is stable for any two moments within the same minute', () => {
    const first = getComputeMetricsRange(new Date('2026-09-03T10:07:00.000Z'))
    const second = getComputeMetricsRange(new Date('2026-09-03T10:07:59.999Z'))

    expect(first).toEqual(second)
  })

  test('spans the configured number of minutes', () => {
    const { startDate, endDate } = getComputeMetricsRange(new Date('2026-09-03T10:07:42.123Z'))
    const spanMinutes = (Date.parse(endDate) - Date.parse(startDate)) / 60_000

    expect(spanMinutes).toBe(COMPUTE_RANGE_MINUTES)
  })

  test('crosses an hour boundary correctly', () => {
    const range = getComputeMetricsRange(new Date('2026-09-03T10:02:10.000Z'))

    expect(range.startDate).toBe('2026-09-03T09:57:00.000Z')
  })

  test('does not mutate the date it is given', () => {
    const now = new Date('2026-09-03T10:07:42.123Z')
    getComputeMetricsRange(now)

    expect(now.toISOString()).toBe('2026-09-03T10:07:42.123Z')
  })
})
