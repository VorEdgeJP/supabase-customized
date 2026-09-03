import type {
  InfraMonitoringAttribute,
  InfraMonitoringMultiResponse,
  InfraMonitoringResponse,
} from '@/data/analytics/infra-monitoring-query'
import { formatBytes } from '@/lib/helpers'

/** Shown wherever a metric hasn't reported a usable value. */
export const NO_VALUE = '—'

/** How often the compute stat re-reads the metrics endpoint, in milliseconds. */
export const COMPUTE_REFRESH_INTERVAL_MS = 30_000

/** How far back the compute stat looks for the most recent sample, in minutes. */
export const COMPUTE_RANGE_MINUTES = 5

/**
 * Attributes the compute stat reads. Percentages come straight from the API and
 * the byte/count pairs back the hover card breakdown.
 */
export const SELF_HOSTED_COMPUTE_ATTRIBUTES = [
  'avg_cpu_usage',
  'ram_usage',
  'ram_usage_used',
  'ram_usage_total',
  'disk_fs_used',
  'disk_fs_size',
  'pg_stat_database_num_backends',
  'max_db_connections',
] as const satisfies readonly InfraMonitoringAttribute[]

export type SelfHostedComputeAttribute = (typeof SELF_HOSTED_COMPUTE_ATTRIBUTES)[number]

export type SelfHostedComputeValues = Record<SelfHostedComputeAttribute, number | null>

function isMultiResponse(
  response: InfraMonitoringResponse
): response is InfraMonitoringMultiResponse {
  return 'series' in response
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Picks the most recent usable sample for every requested attribute. Handles
 * both response shapes the endpoint can return (a single attribute inlines its
 * values on the row, two or more nest them under `values`) and skips gaps, so a
 * missing tail bucket falls back to the last bucket that reported.
 */
export function getLatestValues(
  response: InfraMonitoringResponse | undefined,
  attributes: readonly SelfHostedComputeAttribute[] = SELF_HOSTED_COMPUTE_ATTRIBUTES
): SelfHostedComputeValues {
  const values = Object.fromEntries(
    attributes.map((attribute) => [attribute, null])
  ) as SelfHostedComputeValues

  const rows = response?.data
  if (!Array.isArray(rows)) return values

  const isMulti = response !== undefined && isMultiResponse(response)

  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] as Record<string, unknown>
    const source = isMulti ? ((row.values ?? {}) as Record<string, unknown>) : row

    for (const attribute of attributes) {
      if (values[attribute] !== null) continue
      values[attribute] = toFiniteNumber(source[attribute])
    }

    if (attributes.every((attribute) => values[attribute] !== null)) break
  }

  return values
}

/** Formats a 0-100 percentage for display, rounded to a whole percent. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NO_VALUE
  const clamped = Math.min(Math.max(value, 0), 100)
  return `${Math.round(clamped)}%`
}

/** Formats a byte count, or the placeholder when the metric didn't report. */
export function formatByteValue(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return NO_VALUE
  return formatBytes(value)
}

/** Formats a "used / total" byte pair for the hover card. */
export function formatByteRatio(used: number | null, total: number | null): string {
  return `${formatByteValue(used)} / ${formatByteValue(total)}`
}

/** Formats a whole-number metric such as a connection count. */
export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return NO_VALUE
  return Math.round(value).toLocaleString()
}

/** Formats a "current / max" count pair for the hover card. */
export function formatCountRatio(current: number | null, max: number | null): string {
  return `${formatCount(current)} / ${formatCount(max)}`
}

/**
 * Derives a usage percentage from a used/total pair. Returns null when either
 * side is missing or the total is zero, so the caller renders the placeholder
 * instead of a misleading 0%.
 */
export function getUsagePercent(used: number | null, total: number | null): number | null {
  if (used === null || total === null) return null
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
  return (used / total) * 100
}

/**
 * The range the compute stat requests: the last few minutes, with both ends
 * aligned to the minute. Aligning keeps the query key (and therefore the React
 * Query cache entry) stable within a minute while polling continues.
 */
export function getComputeMetricsRange(now: Date): { startDate: string; endDate: string } {
  const end = new Date(now)
  end.setUTCSeconds(0, 0)
  const start = new Date(end.getTime() - COMPUTE_RANGE_MINUTES * 60 * 1000)
  return { startDate: start.toISOString(), endDate: end.toISOString() }
}
