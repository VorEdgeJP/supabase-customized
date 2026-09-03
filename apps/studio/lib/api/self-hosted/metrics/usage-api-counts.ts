import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'

import { METRICS_GATEWAY, METRICS_REQUESTS_SOURCE, type MetricsGateway } from '../constants'
import { assertSelfHosted } from '../util'
import {
  getPrometheusErrorMessage,
  PrometheusError,
  queryRange,
  type PrometheusRangeSeries,
} from './prometheus'
import type { ProjectLogStatsResponse } from '@/data/analytics/project-log-stats-query'

// Self-hosted implementation of the platform `usage.api-counts` analytics
// endpoint, which powers the Requests chart on the project home. Request counts
// come from the gateway's own Prometheus metrics, so the chart works in a stack
// that has no Logflare. Every PromQL string below is built from a fixed
// template: the only user input that reaches this module is the interval, which
// is validated against an enum before a query is issued.

/** The four services the Requests chart breaks traffic down by. */
export const USAGE_API_COUNT_SERVICES = ['rest', 'auth', 'storage', 'realtime'] as const

export type UsageApiCountService = (typeof USAGE_API_COUNT_SERVICES)[number]

/** Chart granularity, matching `CHART_INTERVALS` in `components/ui/Logs/logs.utils.ts`. */
export const USAGE_API_COUNT_INTERVALS = ['1hr', '1day', '7day'] as const

export type UsageApiCountInterval = (typeof USAGE_API_COUNT_INTERVALS)[number]

type IntervalConfig = {
  /** How far back the chart reaches, in seconds. */
  rangeSeconds: number
  /** Width of one bucket, in seconds. */
  stepSeconds: number
  /** The same step in Prometheus duration syntax. */
  step: string
}

const INTERVAL_CONFIGS: Record<UsageApiCountInterval, IntervalConfig> = {
  // Last 60 minutes
  '1hr': { rangeSeconds: 60 * 60, stepSeconds: 60, step: '1m' },
  // Last 24 hours
  '1day': { rangeSeconds: 24 * 60 * 60, stepSeconds: 60 * 60, step: '1h' },
  // Last 7 days
  '7day': { rangeSeconds: 7 * 24 * 60 * 60, stepSeconds: 24 * 60 * 60, step: '1d' },
}

/** Envoy cluster names, from `docker/volumes/api/envoy/cds.yaml`. */
const ENVOY_CLUSTER_NAMES: Record<UsageApiCountService, string> = {
  rest: 'rest',
  auth: 'auth',
  storage: 'storage',
  realtime: 'realtime',
}

/** Kong service name patterns, from `docker/volumes/api/kong.yml`. */
const KONG_SERVICE_PATTERNS: Record<UsageApiCountService, string> = {
  rest: 'rest-v1.*|graphql-v1',
  auth: 'auth-v1.*',
  storage: 'storage-v1',
  realtime: 'realtime-v1.*',
}

/** The response key each service's count is reported under. */
const RESPONSE_KEYS = {
  rest: 'total_rest_requests',
  auth: 'total_auth_requests',
  storage: 'total_storage_requests',
  realtime: 'total_realtime_requests',
} as const satisfies Record<UsageApiCountService, string>

/**
 * PromQL counting requests handled for one service over a single bucket.
 *
 * Kong renamed its request counter between major versions: 3.x exports
 * `kong_http_requests_total` and 2.8 exports `kong_http_status`. Both are asked
 * for and combined with `or`, so the query works on either version without the
 * stack having to declare which one it runs.
 */
export function buildUsageApiCountsQuery(
  service: UsageApiCountService,
  gateway: MetricsGateway,
  step: string
): string {
  if (gateway === 'kong') {
    const pattern = KONG_SERVICE_PATTERNS[service]
    return (
      `sum(increase(kong_http_requests_total{service=~"${pattern}"}[${step}]))` +
      ` or sum(increase(kong_http_status{service=~"${pattern}"}[${step}]))`
    )
  }

  const cluster = ENVOY_CLUSTER_NAMES[service]
  return `sum(increase(envoy_cluster_upstream_rq_completed{envoy_cluster_name="${cluster}"}[${step}]))`
}

const getUsageApiCountsSchema = z.object({
  interval: z.enum(USAGE_API_COUNT_INTERVALS),
})

export type GetUsageApiCountsVariables = z.input<typeof getUsageApiCountsSchema>

/**
 * Unix seconds of every bucket's start, oldest first. Buckets are aligned to
 * the step, like Logflare's `timestamp_trunc`, and the last one is the bucket
 * that is still in progress. `now` is the current time in seconds.
 */
function buildBucketGrid({ rangeSeconds, stepSeconds }: IntervalConfig, now: number): number[] {
  const currentBucketStart = Math.floor(now / stepSeconds) * stepSeconds
  const bucketCount = Math.round(rangeSeconds / stepSeconds)

  return Array.from(
    { length: bucketCount },
    (_, index) => currentBucketStart - (bucketCount - 1 - index) * stepSeconds
  )
}

/** Sum of one Prometheus matrix's samples, keyed by sample timestamp. */
function toCountsByTimestamp(series: PrometheusRangeSeries[]): Map<number, number> {
  const counts = new Map<number, number>()
  // Every template aggregates with `sum()`, so at most one series comes back.
  for (const [timestamp, rawValue] of series[0]?.values ?? []) {
    const value = Number.parseFloat(rawValue)
    // Prometheus emits NaN for gaps in some expressions; treat those as no data.
    if (Number.isFinite(value)) counts.set(timestamp, Math.max(0, Math.round(value)))
  }
  return counts
}

/**
 * Request counts for one service on the bucket grid, filling gaps with zero.
 *
 * `increase(...[step])` evaluated at time `t` covers `(t - step, t]`, so a
 * bucket starting at `b` is read at `b + step`. Complete buckets come from one
 * range query over those end times. The bucket still in progress is read at
 * `now` with a window covering only the elapsed part of the bucket, so the
 * chart shows the current period like the Logflare-backed one does.
 */
async function fetchCountsOnGrid({
  service,
  config,
  timestamps,
  now,
}: {
  service: UsageApiCountService
  config: IntervalConfig
  timestamps: number[]
  now: number
}): Promise<number[]> {
  const { stepSeconds, step } = config
  const currentBucketStart = timestamps[timestamps.length - 1]
  const completeBucketStarts = timestamps.slice(0, -1)

  const [completeSeries, currentSeries] = await Promise.all([
    completeBucketStarts.length > 0
      ? queryRange({
          query: buildUsageApiCountsQuery(service, METRICS_GATEWAY, step),
          start: new Date((completeBucketStarts[0] + stepSeconds) * 1000),
          end: new Date(
            (completeBucketStarts[completeBucketStarts.length - 1] + stepSeconds) * 1000
          ),
          step,
        })
      : Promise.resolve([]),
    queryRange({
      query: buildUsageApiCountsQuery(
        service,
        METRICS_GATEWAY,
        `${Math.max(1, now - currentBucketStart)}s`
      ),
      start: new Date(now * 1000),
      end: new Date(now * 1000),
      step: '1s',
    }),
  ])

  const completeCounts = toCountsByTimestamp(completeSeries)
  const currentCount = toCountsByTimestamp(currentSeries).get(now) ?? 0

  return timestamps.map((bucketStart) =>
    bucketStart === currentBucketStart
      ? currentCount
      : (completeCounts.get(bucketStart + stepSeconds) ?? 0)
  )
}

/**
 * Request counts per service over the requested interval, shaped like the
 * platform `usage.api-counts` response.
 *
 * `now` is injectable so tests can pin the bucket grid.
 */
export async function getUsageApiCounts(
  variables: GetUsageApiCountsVariables,
  now: Date = new Date()
): Promise<ProjectLogStatsResponse> {
  assertSelfHosted()

  const { interval } = getUsageApiCountsSchema.parse(variables)
  const config = INTERVAL_CONFIGS[interval]
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const timestamps = buildBucketGrid(config, nowSeconds)

  const countsPerService = await Promise.all(
    USAGE_API_COUNT_SERVICES.map((service) =>
      fetchCountsOnGrid({ service, config, timestamps, now: nowSeconds })
    )
  )

  return {
    result: timestamps.map((timestamp, index) => {
      const row: ProjectLogStatsResponse['result'][number] = {
        timestamp: new Date(timestamp * 1000).toISOString(),
        total_rest_requests: 0,
        total_auth_requests: 0,
        total_storage_requests: 0,
        total_realtime_requests: 0,
      }

      USAGE_API_COUNT_SERVICES.forEach((service, serviceIndex) => {
        row[RESPONSE_KEYS[service]] = countsPerService[serviceIndex][index]
      })

      return row
    }),
  }
}

/**
 * True when this analytics endpoint should be answered from Prometheus instead
 * of being forwarded to Logflare.
 */
export function shouldServeUsageApiCountsFromPrometheus(name: string): boolean {
  return name === 'usage.api-counts' && METRICS_REQUESTS_SOURCE === 'prometheus'
}

/**
 * Answers a `usage.api-counts` request from Prometheus. It lives next to the
 * query so the shared analytics route only needs a two-line branch.
 */
export async function handleUsageApiCounts(req: NextApiRequest, res: NextApiResponse) {
  try {
    const data = await getUsageApiCounts({ interval: req.query.interval as UsageApiCountInterval })
    return res.status(200).json(data)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: {
          message: `Invalid interval. Expected one of ${USAGE_API_COUNT_INTERVALS.join(', ')}.`,
        },
      })
    }
    // The message is already normalized to a kind of failure and never contains
    // the Prometheus URL or its credentials.
    if (error instanceof PrometheusError) {
      return res.status(502).json({ error: { message: error.message } })
    }
    return res.status(500).json({ error: { message: getPrometheusErrorMessage(error) } })
  }
}
