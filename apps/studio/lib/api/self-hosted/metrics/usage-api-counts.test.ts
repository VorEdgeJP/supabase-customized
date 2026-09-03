import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import type { MetricsGateway, MetricsRequestsSource } from '../constants'
import { assertSelfHosted } from '../util'
import { queryRange, type PrometheusRangeSeries } from './prometheus'
import {
  buildUsageApiCountsQuery,
  getUsageApiCounts,
  shouldServeUsageApiCountsFromPrometheus,
  USAGE_API_COUNT_SERVICES,
  type UsageApiCountService,
} from './usage-api-counts'

const { config } = vi.hoisted(() => ({
  config: {
    gateway: 'envoy' as MetricsGateway,
    requestsSource: 'prometheus' as MetricsRequestsSource,
  },
}))

vi.mock('../constants', () => ({
  METRICS_PROMETHEUS_URL: 'http://prometheus:9090',
  METRICS_TIMEOUT_MS: 5000,
  get METRICS_GATEWAY() {
    return config.gateway
  },
  get METRICS_REQUESTS_SOURCE() {
    return config.requestsSource
  },
}))

vi.mock('../util', () => ({
  assertSelfHosted: vi.fn(),
}))

vi.mock('./prometheus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prometheus')>()),
  queryRange: vi.fn(),
}))

const mockedQueryRange = vi.mocked(queryRange)

/** A matrix with one sample per timestamp, the shape every template produces. */
const series = (values: Array<[number, string]>): PrometheusRangeSeries[] => [
  { metric: {}, values },
]

/** Unix seconds of the start of the bucket in progress, for a grid aligned to `stepSeconds`. */
const currentBucketStart = (now: Date, stepSeconds: number) =>
  Math.floor(now.getTime() / 1000 / stepSeconds) * stepSeconds

const nowSeconds = (now: Date) => Math.floor(now.getTime() / 1000)

/**
 * The recorded queryRange calls for one service. Each service issues one range
 * query for the complete buckets followed by one instant-style query for the
 * bucket in progress, in service order.
 */
const callsFor = (service: UsageApiCountService) => {
  const index = USAGE_API_COUNT_SERVICES.indexOf(service) * 2
  return {
    complete: mockedQueryRange.mock.calls[index][0],
    current: mockedQueryRange.mock.calls[index + 1][0],
  }
}

describe('buildUsageApiCountsQuery', () => {
  it('builds an Envoy cluster query for every service', () => {
    expect(buildUsageApiCountsQuery('rest', 'envoy', '1m')).toBe(
      'sum(increase(envoy_cluster_upstream_rq_completed{envoy_cluster_name="rest"}[1m]))'
    )
    expect(buildUsageApiCountsQuery('auth', 'envoy', '1m')).toContain('envoy_cluster_name="auth"')
    expect(buildUsageApiCountsQuery('storage', 'envoy', '1m')).toContain(
      'envoy_cluster_name="storage"'
    )
    expect(buildUsageApiCountsQuery('realtime', 'envoy', '1m')).toContain(
      'envoy_cluster_name="realtime"'
    )
  })

  it('builds a Kong query that works on both metric names', () => {
    expect(buildUsageApiCountsQuery('rest', 'kong', '1h')).toBe(
      'sum(increase(kong_http_requests_total{service=~"rest-v1.*|graphql-v1"}[1h]))' +
        ' or sum(increase(kong_http_status{service=~"rest-v1.*|graphql-v1"}[1h]))'
    )
    expect(buildUsageApiCountsQuery('auth', 'kong', '1h')).toContain('service=~"auth-v1.*"')
    expect(buildUsageApiCountsQuery('storage', 'kong', '1h')).toContain('service=~"storage-v1"')
    expect(buildUsageApiCountsQuery('realtime', 'kong', '1h')).toContain('service=~"realtime-v1.*"')
  })

  it('interpolates the step into the rate window', () => {
    expect(buildUsageApiCountsQuery('rest', 'envoy', '1d')).toContain('[1d]')
    expect(buildUsageApiCountsQuery('rest', 'kong', '1d')).toContain('[1d]')
  })
})

describe('shouldServeUsageApiCountsFromPrometheus', () => {
  beforeEach(() => {
    config.requestsSource = 'prometheus'
  })

  it('is true only for the usage.api-counts endpoint', () => {
    expect(shouldServeUsageApiCountsFromPrometheus('usage.api-counts')).toBe(true)
    expect(shouldServeUsageApiCountsFromPrometheus('logs.all')).toBe(false)
  })

  it('is false when the requests source is not Prometheus', () => {
    config.requestsSource = 'logflare'
    expect(shouldServeUsageApiCountsFromPrometheus('usage.api-counts')).toBe(false)
    config.requestsSource = 'disabled'
    expect(shouldServeUsageApiCountsFromPrometheus('usage.api-counts')).toBe(false)
  })
})

describe('getUsageApiCounts', () => {
  const now = new Date('2026-09-03T12:34:56.000Z')

  beforeEach(() => {
    vi.clearAllMocks()
    config.gateway = 'envoy'
    config.requestsSource = 'prometheus'
    mockedQueryRange.mockResolvedValue([])
  })

  it('asserts the environment is self-hosted', async () => {
    await getUsageApiCounts({ interval: '1hr' }, now)

    expect(vi.mocked(assertSelfHosted)).toHaveBeenCalled()
  })

  it('rejects an interval that is not on the allowlist', async () => {
    await expect(
      // The route passes the raw query string through, so the cast mirrors it.
      getUsageApiCounts({ interval: '30day' as never }, now)
    ).rejects.toBeInstanceOf(ZodError)

    expect(mockedQueryRange).not.toHaveBeenCalled()
  })

  it('covers the last 60 minutes in 1-minute buckets for 1hr', async () => {
    const { result } = await getUsageApiCounts({ interval: '1hr' }, now)

    expect(result).toHaveLength(60)
    expect(result[59].timestamp).toBe('2026-09-03T12:34:00.000Z')
    expect(result[0].timestamp).toBe('2026-09-03T11:35:00.000Z')

    // One range query for the 59 complete buckets plus one for the bucket in
    // progress, per service.
    expect(mockedQueryRange).toHaveBeenCalledTimes(8)
    // Complete buckets are read at their end, one step after their start.
    expect(callsFor('rest').complete).toMatchObject({
      step: '1m',
      start: new Date('2026-09-03T11:36:00.000Z'),
      end: new Date('2026-09-03T12:34:00.000Z'),
    })
    // The bucket in progress is read at `now` over the elapsed 56 seconds.
    expect(callsFor('rest').current).toMatchObject({
      step: '1s',
      start: now,
      end: now,
    })
    expect(callsFor('rest').current.query).toContain('[56s]')
  })

  it('covers the last 24 hours in 1-hour buckets for 1day', async () => {
    const { result } = await getUsageApiCounts({ interval: '1day' }, now)

    expect(result).toHaveLength(24)
    expect(result[23].timestamp).toBe('2026-09-03T12:00:00.000Z')
    expect(result[0].timestamp).toBe('2026-09-02T13:00:00.000Z')
    expect(callsFor('rest').complete.step).toBe('1h')
    expect(callsFor('rest').current.query).toContain(`[${34 * 60 + 56}s]`)
  })

  it('covers the last 7 days in 1-day buckets for 7day', async () => {
    const { result } = await getUsageApiCounts({ interval: '7day' }, now)

    expect(result).toHaveLength(7)
    expect(result[6].timestamp).toBe('2026-09-03T00:00:00.000Z')
    expect(result[0].timestamp).toBe('2026-08-28T00:00:00.000Z')
    expect(callsFor('rest').complete.step).toBe('1d')
    expect(callsFor('rest').current.query).toContain(`[${12 * 3600 + 34 * 60 + 56}s]`)
  })

  it('queries the Envoy clusters when the gateway is Envoy', async () => {
    await getUsageApiCounts({ interval: '1hr' }, now)

    expect(callsFor('rest').complete.query).toBe(
      'sum(increase(envoy_cluster_upstream_rq_completed{envoy_cluster_name="rest"}[1m]))'
    )
    expect(callsFor('realtime').complete.query).toContain('envoy_cluster_name="realtime"')
  })

  it('queries the Kong services when the gateway is Kong', async () => {
    config.gateway = 'kong'

    await getUsageApiCounts({ interval: '1hr' }, now)

    expect(callsFor('storage').complete.query).toBe(
      'sum(increase(kong_http_requests_total{service=~"storage-v1"}[1m]))' +
        ' or sum(increase(kong_http_status{service=~"storage-v1"}[1m]))'
    )
  })

  it('maps each service onto its own response key', async () => {
    const at = nowSeconds(now)
    mockedQueryRange.mockImplementation(async ({ query, step }) => {
      if (step !== '1s') return []
      if (query.includes('"rest"')) return series([[at, '1']])
      if (query.includes('"auth"')) return series([[at, '2']])
      if (query.includes('"storage"')) return series([[at, '3']])
      return series([[at, '4']])
    })

    const { result } = await getUsageApiCounts({ interval: '7day' }, now)

    expect(result[6]).toEqual({
      timestamp: '2026-09-03T00:00:00.000Z',
      total_rest_requests: 1,
      total_auth_requests: 2,
      total_storage_requests: 3,
      total_realtime_requests: 4,
    })
  })

  it('labels each complete bucket by its start and fills gaps with zero', async () => {
    const current = currentBucketStart(now, 86400)
    mockedQueryRange.mockImplementation(async ({ step }) =>
      // The sample read at the current bucket's start is the count of the
      // bucket that ended there, i.e. yesterday's.
      step === '1s' ? series([[nowSeconds(now), '7']]) : series([[current, '5']])
    )

    const { result } = await getUsageApiCounts({ interval: '7day' }, now)

    expect(result.map((row) => row.total_rest_requests)).toEqual([0, 0, 0, 0, 0, 5, 7])
  })

  it('returns every bucket at zero when Prometheus has no series at all', async () => {
    mockedQueryRange.mockResolvedValue([])

    const { result } = await getUsageApiCounts({ interval: '7day' }, now)

    expect(result).toHaveLength(7)
    expect(result.every((row) => row.total_auth_requests === 0)).toBe(true)
  })

  it('rounds fractional counts and drops negative or non-finite samples', async () => {
    const current = currentBucketStart(now, 86400)
    mockedQueryRange.mockImplementation(async ({ step }) =>
      step === '1s'
        ? series([[nowSeconds(now), 'NaN']])
        : series([
            [current - 86400, '10.4'],
            [current, '-3'],
          ])
    )

    const { result } = await getUsageApiCounts({ interval: '7day' }, now)

    expect(result[4].total_rest_requests).toBe(10)
    expect(result[5].total_rest_requests).toBe(0)
    expect(result[6].total_rest_requests).toBe(0)
  })

  it('ignores samples that fall outside the bucket grid', async () => {
    const current = currentBucketStart(now, 86400)
    // A sample 30 seconds off the grid belongs to no bucket.
    mockedQueryRange.mockResolvedValue(series([[current - 30, '99']]))

    const { result } = await getUsageApiCounts({ interval: '7day' }, now)

    expect(result.every((row) => row.total_rest_requests === 0)).toBe(true)
  })
})
