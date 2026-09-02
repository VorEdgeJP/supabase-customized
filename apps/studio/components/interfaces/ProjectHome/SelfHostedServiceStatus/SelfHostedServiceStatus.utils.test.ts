import { describe, expect, test } from 'vitest'

import {
  formatLatency,
  formatServiceVersion,
  getOverallStatus,
  getOverallStatusLabel,
  getServiceDisplayName,
  getStatusDotClass,
  getStatusMessage,
  SELF_HOSTED_SERVICE_DISPLAY_NAMES,
} from './SelfHostedServiceStatus.utils'
import {
  SELF_HOSTED_SERVICE_NAMES,
  type SelfHostedServiceHealth,
  type SelfHostedServiceStatus,
} from '@/lib/api/self-hosted/service-health.types'

const service = (
  name: SelfHostedServiceHealth['name'],
  status: SelfHostedServiceStatus,
  overrides: Partial<SelfHostedServiceHealth> = {}
): SelfHostedServiceHealth => ({
  name,
  status,
  latencyMs: 12,
  checkedAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
})

describe('SELF_HOSTED_SERVICE_DISPLAY_NAMES', () => {
  test('covers every service name', () => {
    expect(Object.keys(SELF_HOSTED_SERVICE_DISPLAY_NAMES).sort()).toStrictEqual(
      [...SELF_HOSTED_SERVICE_NAMES].sort()
    )
  })

  test('maps each service to its display name', () => {
    expect(getServiceDisplayName('db')).toBe('Database')
    expect(getServiceDisplayName('auth')).toBe('Auth')
    expect(getServiceDisplayName('rest')).toBe('PostgREST')
    expect(getServiceDisplayName('realtime')).toBe('Realtime')
    expect(getServiceDisplayName('storage')).toBe('Storage')
    expect(getServiceDisplayName('functions')).toBe('Edge Functions')
    expect(getServiceDisplayName('meta')).toBe('Postgres Meta')
    expect(getServiceDisplayName('pooler')).toBe('Connection Pooler')
    expect(getServiceDisplayName('api_gateway')).toBe('API Gateway')
  })
})

describe('getOverallStatus', () => {
  test('returns CHECKING for an empty list', () => {
    expect(getOverallStatus([])).toBe('CHECKING')
  })

  test('returns HEALTHY when every service is healthy', () => {
    expect(
      getOverallStatus([service('db', 'ACTIVE_HEALTHY'), service('auth', 'ACTIVE_HEALTHY')])
    ).toBe('HEALTHY')
  })

  test('treats disabled services as operational', () => {
    expect(getOverallStatus([service('db', 'ACTIVE_HEALTHY'), service('pooler', 'DISABLED')])).toBe(
      'HEALTHY'
    )
  })

  test('returns HEALTHY when every service is disabled', () => {
    expect(getOverallStatus([service('pooler', 'DISABLED')])).toBe('HEALTHY')
  })

  test('returns UNHEALTHY when any service is unhealthy', () => {
    expect(
      getOverallStatus([
        service('db', 'ACTIVE_HEALTHY'),
        service('pooler', 'DISABLED'),
        service('storage', 'UNHEALTHY'),
      ])
    ).toBe('UNHEALTHY')
  })
})

describe('getOverallStatusLabel', () => {
  test.each([
    ['CHECKING', 'Checking...'],
    ['HEALTHY', 'Healthy'],
    ['UNHEALTHY', 'Unhealthy'],
  ] as const)('labels %s as "%s"', (status, expected) => {
    expect(getOverallStatusLabel(status)).toBe(expected)
  })
})

describe('getStatusMessage', () => {
  test.each([
    ['ACTIVE_HEALTHY', 'Healthy'],
    ['DISABLED', 'Disabled'],
    ['UNHEALTHY', 'Unhealthy'],
  ] as const)('describes %s as "%s"', (status, expected) => {
    expect(getStatusMessage(status)).toBe(expected)
  })
})

describe('getStatusDotClass', () => {
  test.each([
    ['ACTIVE_HEALTHY', 'bg-brand'],
    ['DISABLED', 'bg-foreground-lighter'],
    ['UNHEALTHY', 'bg-selection'],
  ] as const)('styles %s as %s', (status, expected) => {
    expect(getStatusDotClass(status)).toBe(expected)
  })
})

describe('formatLatency', () => {
  test('formats a whole number of milliseconds', () => {
    expect(formatLatency(42)).toBe('42 ms')
  })

  test('rounds fractional milliseconds', () => {
    expect(formatLatency(41.6)).toBe('42 ms')
    expect(formatLatency(0.4)).toBe('0 ms')
  })

  test('formats zero latency', () => {
    expect(formatLatency(0)).toBe('0 ms')
  })

  test('returns undefined when the check did not complete', () => {
    expect(formatLatency(null)).toBeUndefined()
  })

  test('returns undefined for non-finite or negative values', () => {
    expect(formatLatency(Number.NaN)).toBeUndefined()
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(formatLatency(-1)).toBeUndefined()
  })
})

describe('formatServiceVersion', () => {
  test('drops the build platform from a Postgres version string', () => {
    expect(
      formatServiceVersion(
        'PostgreSQL 15.8 (Debian 15.8-1) on x86_64-pc-linux-gnu, compiled by gcc 12.2.0, 64-bit'
      )
    ).toBe('PostgreSQL 15.8 (Debian 15.8-1)')
  })

  test('keeps a version string that has no platform suffix', () => {
    expect(formatServiceVersion('PostgreSQL 17.0')).toBe('PostgreSQL 17.0')
  })

  test('returns undefined for a missing, empty, or non-string version', () => {
    expect(formatServiceVersion(undefined)).toBeUndefined()
    expect(formatServiceVersion('   ')).toBeUndefined()
    expect(formatServiceVersion(15)).toBeUndefined()
  })
})
