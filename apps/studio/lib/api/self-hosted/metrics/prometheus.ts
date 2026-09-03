import { z } from 'zod'

import { METRICS_PROMETHEUS_URL, METRICS_TIMEOUT_MS } from '../constants'

// Minimal Prometheus HTTP API client for the self-hosted metrics routes. Only
// call this from server-side code: the Prometheus URL is never exposed to the
// browser, and it may carry basic-auth credentials.

/** Granularity requested by the infra-monitoring and usage charts. */
export const METRICS_INTERVALS = ['1m', '1h', '1d'] as const

export type MetricsInterval = (typeof METRICS_INTERVALS)[number]

/** One matrix series as returned by `/api/v1/query_range`. */
export type PrometheusRangeSeries = {
  metric: Record<string, string>
  /** `[unix seconds, sample value]` pairs. Prometheus sends values as strings. */
  values: Array<[number, string]>
}

/**
 * Error raised for every failed Prometheus request. The message is normalized
 * to a category (connection refused, timeout, HTTP status) so that a URL
 * carrying credentials can never reach a log line or the browser.
 */
export class PrometheusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrometheusError'
  }
}

const prometheusRangeSeriesSchema = z.object({
  metric: z.record(z.string(), z.string()),
  values: z.array(z.tuple([z.number(), z.string()])),
})

const prometheusRangeResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(prometheusRangeSeriesSchema),
  }),
})

/** Reads a string property off a thrown value without asserting its type. */
function getStringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  const candidate = Reflect.get(value, property)
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * Turns a thrown fetch error into a message that is safe to surface. Aborts
 * surface as a DOMException, which is not an Error subclass in every runtime,
 * so the shape is probed rather than narrowed with instanceof.
 */
export function getPrometheusErrorMessage(error: unknown): string {
  if (error instanceof PrometheusError) return error.message

  const name = getStringProperty(error, 'name')
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `Timed out after ${METRICS_TIMEOUT_MS}ms`
  }

  const cause =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'cause') : undefined
  // undici reports the OS-level reason on the cause, not on the thrown TypeError.
  const code = getStringProperty(error, 'code') ?? getStringProperty(cause, 'code')

  if (code === 'ECONNREFUSED') return 'Connection refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found'
  if (code === 'ECONNRESET') return 'Connection reset'
  if (code !== undefined) return code

  // The raw message is not echoed: fetch puts the request URL, credentials
  // included, into the message for a malformed URL.
  return 'Could not reach Prometheus'
}

/** Query step, in Prometheus duration syntax, for a chart granularity. */
export function stepFor(interval: MetricsInterval): string {
  switch (interval) {
    case '1m':
      return '1m'
    case '1h':
      return '1h'
    case '1d':
      return '1d'
  }
}

/**
 * Lookback window for `rate()` / `increase()`. It has to cover at least a few
 * scrapes, so the finest granularity widens beyond its step.
 */
export function rateWindowFor(interval: MetricsInterval): string {
  switch (interval) {
    case '1m':
      return '5m'
    case '1h':
      return '1h'
    case '1d':
      return '1d'
  }
}

/** Number of seconds one step covers, used to align samples onto a bucket grid. */
export function stepSecondsFor(interval: MetricsInterval): number {
  switch (interval) {
    case '1m':
      return 60
    case '1h':
      return 3600
    case '1d':
      return 86400
  }
}

/**
 * Runs a range query against Prometheus. `query` is always built from a fixed
 * template in this package — never from raw user input.
 */
export async function queryRange({
  query,
  start,
  end,
  step,
}: {
  query: string
  start: Date
  end: Date
  step: string
}): Promise<PrometheusRangeSeries[]> {
  if (METRICS_PROMETHEUS_URL === undefined) {
    throw new PrometheusError('Prometheus is not configured')
  }

  const params = new URLSearchParams({
    query,
    start: String(Math.floor(start.getTime() / 1000)),
    end: String(Math.floor(end.getTime() / 1000)),
    step,
  })
  const url = `${METRICS_PROMETHEUS_URL.replace(/\/+$/, '')}/api/v1/query_range?${params.toString()}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new PrometheusError(getPrometheusErrorMessage(error))
  }

  if (!response.ok) {
    try {
      await response.body?.cancel()
    } catch {
      // Cancelling an already-consumed body is not an error worth reporting.
    }
    throw new PrometheusError(`Prometheus responded with HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new PrometheusError('Prometheus returned a malformed response')
  }

  const parsed = prometheusRangeResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new PrometheusError('Prometheus returned an unexpected response')
  }

  return parsed.data.data.result
}
