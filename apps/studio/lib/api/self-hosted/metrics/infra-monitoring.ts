import { z } from 'zod'

import { METRICS_DISK_MOUNTPOINT, METRICS_NETWORK_DEVICE_REGEX } from '../constants'
import { assertSelfHosted } from '../util'
import {
  METRICS_INTERVALS,
  queryRange,
  rateWindowFor,
  stepFor,
  stepSecondsFor,
  type MetricsInterval,
  type PrometheusRangeSeries,
} from './prometheus'
import type {
  InfraMonitoringAttribute,
  InfraMonitoringMultiResponse,
  InfraMonitoringResponse,
  InfraMonitoringSeriesMetadata,
  InfraMonitoringSingleResponse,
} from '@/data/analytics/infra-monitoring-query'

// Self-hosted implementation of the platform `infra-monitoring` endpoint. Every
// PromQL string is built from the fixed templates below; the only user input
// that reaches this module is an allowlisted attribute name, an ISO date and an
// interval enum, all validated with zod before a query is issued.

/**
 * Every attribute the platform endpoint accepts. Attributes without a
 * Prometheus equivalent stay on the list and answer with an empty series, which
 * matches how the charts behave when a metric is unavailable. Anything outside
 * the list is rejected.
 */
export const INFRA_MONITORING_ATTRIBUTES = [
  'cpu_usage',
  'cpu_usage_busy_system',
  'cpu_usage_busy_user',
  'cpu_usage_busy_iowait',
  'cpu_usage_busy_irqs',
  'cpu_usage_busy_other',
  'cpu_usage_busy_idle',
  'max_cpu_usage',
  'avg_cpu_usage',
  'ram_usage',
  'ram_usage_total',
  'ram_usage_available',
  'ram_usage_used',
  'ram_usage_free',
  'ram_usage_cache_and_buffers',
  'ram_usage_swap',
  'ram_commit_used',
  'ram_commit_limit',
  'swap_usage',
  'client_connections_pgbouncer',
  'network_receive_bytes',
  'network_transmit_bytes',
  'pgbouncer_pools_client_active_connections',
  'supavisor_connections_active',
  'client_connections_postgres',
  'client_connections_authenticator',
  'client_connections_supabase_auth_admin',
  'client_connections_supabase_storage_admin',
  'client_connections_supabase_admin',
  'client_connections_other',
  'realtime_connections_connected',
  'realtime_channel_joins',
  'realtime_channel_events',
  'realtime_channel_presence_events',
  'realtime_channel_db_events',
  'realtime_authorization_rls_execution_time',
  'realtime_read_authorization_rls_execution_time',
  'realtime_write_authorization_rls_execution_time',
  'realtime_payload_size',
  'realtime_replication_connection_lag',
  'realtime_sum_connections_connected',
  'disk_io_budget',
  'disk_io_consumption',
  'disk_io_usage',
  'disk_iops_read',
  'disk_iops_write',
  'disk_bytes_read',
  'disk_bytes_written',
  'pg_database_size',
  'disk_fs_size',
  'disk_fs_avail',
  'disk_fs_used',
  'disk_fs_used_wal',
  'disk_fs_used_system',
  'physical_replication_lag_physical_replication_lag_seconds',
  'pg_stat_database_num_backends',
  'max_db_connections',
] as const satisfies readonly InfraMonitoringAttribute[]

export type SelfHostedInfraMonitoringAttribute = (typeof INFRA_MONITORING_ATTRIBUTES)[number]

/** Unit the chart renders the series with, mirroring the platform response. */
export type InfraMonitoringFormat = '%' | 'bytes' | 'number'

/**
 * Escapes a value for a PromQL string literal. Only env-provided values (the
 * disk mountpoint and the network device pattern) are interpolated, but they
 * are still escaped so a stray quote cannot change the query's shape.
 */
export function escapePromqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

type PromqlTemplate = {
  /** `window` is the `rate()` lookback for the requested interval. */
  build: (context: { window: string; mountpoint: string; networkDeviceRegex: string }) => string
  format: InfraMonitoringFormat
}

/** Devices that mirror or loop back real block devices and would double-count. */
const EXCLUDED_DISK_DEVICES = 'loop.*|dm-.*'

/** Virtual filesystems that are not the data volume. */
const EXCLUDED_FILESYSTEM_TYPES = 'tmpfs|overlay'

const filesystemSelector = (mountpoint: string) =>
  `{mountpoint="${mountpoint}",fstype!~"${EXCLUDED_FILESYSTEM_TYPES}"}`

const cpuBusyRatio = (modeSelector: string, window: string) =>
  `100 * sum(rate(node_cpu_seconds_total{${modeSelector}}[${window}])) / sum(rate(node_cpu_seconds_total[${window}]))`

const diskRate = (metric: string, window: string) =>
  `sum(rate(${metric}{device!~"${EXCLUDED_DISK_DEVICES}"}[${window}]))`

/**
 * PromQL for every attribute that maps to a single query. Kept as one table so
 * the generated queries can be snapshotted in tests.
 */
export const INFRA_MONITORING_QUERIES: Partial<
  Record<SelfHostedInfraMonitoringAttribute, PromqlTemplate>
> = {
  cpu_usage: {
    build: ({ window }) => `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[${window}])))`,
    format: '%',
  },
  avg_cpu_usage: {
    build: ({ window }) => `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[${window}])))`,
    format: '%',
  },
  max_cpu_usage: {
    build: ({ window }) => `100 * (1 - min(rate(node_cpu_seconds_total{mode="idle"}[${window}])))`,
    format: '%',
  },
  cpu_usage_busy_system: {
    build: ({ window }) => cpuBusyRatio('mode="system"', window),
    format: '%',
  },
  cpu_usage_busy_user: {
    build: ({ window }) => cpuBusyRatio('mode="user"', window),
    format: '%',
  },
  cpu_usage_busy_iowait: {
    build: ({ window }) => cpuBusyRatio('mode="iowait"', window),
    format: '%',
  },
  cpu_usage_busy_irqs: {
    build: ({ window }) => cpuBusyRatio('mode=~"irq|softirq"', window),
    format: '%',
  },
  cpu_usage_busy_other: {
    build: ({ window }) => cpuBusyRatio('mode=~"nice|steal"', window),
    format: '%',
  },
  cpu_usage_busy_idle: {
    build: ({ window }) => cpuBusyRatio('mode="idle"', window),
    format: '%',
  },
  ram_usage: {
    build: () => '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
    format: '%',
  },
  ram_usage_total: { build: () => 'node_memory_MemTotal_bytes', format: 'bytes' },
  ram_usage_available: { build: () => 'node_memory_MemAvailable_bytes', format: 'bytes' },
  ram_usage_free: { build: () => 'node_memory_MemFree_bytes', format: 'bytes' },
  ram_usage_used: {
    build: () => 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes',
    format: 'bytes',
  },
  ram_usage_cache_and_buffers: {
    build: () => 'node_memory_Cached_bytes + node_memory_Buffers_bytes',
    format: 'bytes',
  },
  ram_usage_swap: {
    build: () => 'node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes',
    format: 'bytes',
  },
  swap_usage: {
    // Multiplying by the `> bool 0` comparison keeps a host without swap at 0
    // instead of dividing by zero.
    build: () =>
      '100 * (1 - node_memory_SwapFree_bytes / clamp_min(node_memory_SwapTotal_bytes, 1)) * (node_memory_SwapTotal_bytes > bool 0)',
    format: '%',
  },
  disk_fs_size: {
    build: ({ mountpoint }) => `node_filesystem_size_bytes${filesystemSelector(mountpoint)}`,
    format: 'bytes',
  },
  disk_fs_avail: {
    build: ({ mountpoint }) => `node_filesystem_avail_bytes${filesystemSelector(mountpoint)}`,
    format: 'bytes',
  },
  disk_fs_used: {
    build: ({ mountpoint }) =>
      `node_filesystem_size_bytes${filesystemSelector(mountpoint)} - node_filesystem_avail_bytes${filesystemSelector(mountpoint)}`,
    format: 'bytes',
  },
  // Custom postgres-exporter query, see docker/volumes/metrics.
  disk_fs_used_wal: { build: () => 'sum(pg_wal_size_bytes)', format: 'bytes' },
  pg_database_size: { build: () => 'sum(pg_database_size_bytes)', format: 'bytes' },
  disk_iops_read: {
    build: ({ window }) => diskRate('node_disk_reads_completed_total', window),
    format: 'number',
  },
  disk_iops_write: {
    build: ({ window }) => diskRate('node_disk_writes_completed_total', window),
    format: 'number',
  },
  disk_bytes_read: {
    build: ({ window }) => diskRate('node_disk_read_bytes_total', window),
    format: 'bytes',
  },
  disk_bytes_written: {
    build: ({ window }) => diskRate('node_disk_written_bytes_total', window),
    format: 'bytes',
  },
  network_receive_bytes: {
    build: ({ window, networkDeviceRegex }) =>
      `sum(rate(node_network_receive_bytes_total{device=~"${networkDeviceRegex}"}[${window}]))`,
    format: 'bytes',
  },
  network_transmit_bytes: {
    build: ({ window, networkDeviceRegex }) =>
      `sum(rate(node_network_transmit_bytes_total{device=~"${networkDeviceRegex}"}[${window}]))`,
    format: 'bytes',
  },
  pg_stat_database_num_backends: {
    build: () => 'sum(pg_stat_database_numbackends)',
    format: 'number',
  },
  max_db_connections: { build: () => 'pg_settings_max_connections', format: 'number' },
}

/**
 * Attributes computed from other attributes rather than from a query of their
 * own. `buildInfraMonitoringQuery` returns null for these; `getInfraMonitoring`
 * fetches their inputs and combines them.
 */
const DERIVED_ATTRIBUTES = {
  disk_fs_used_system: {
    inputs: ['disk_fs_used', 'pg_database_size', 'disk_fs_used_wal'],
    format: 'bytes',
  },
} as const satisfies Partial<
  Record<
    SelfHostedInfraMonitoringAttribute,
    { inputs: readonly SelfHostedInfraMonitoringAttribute[]; format: InfraMonitoringFormat }
  >
>

type DerivedAttribute = keyof typeof DERIVED_ATTRIBUTES

function isDerivedAttribute(
  attribute: SelfHostedInfraMonitoringAttribute
): attribute is DerivedAttribute {
  return attribute in DERIVED_ATTRIBUTES
}

/**
 * PromQL for one attribute, or null when the attribute has no single query of
 * its own: either Prometheus cannot supply it in a self-hosted stack, or it is
 * derived from other attributes.
 */
export function buildInfraMonitoringQuery(
  attribute: SelfHostedInfraMonitoringAttribute,
  interval: MetricsInterval
): { promql: string; format: InfraMonitoringFormat } | null {
  const template = INFRA_MONITORING_QUERIES[attribute]
  if (template === undefined) return null

  return {
    promql: template.build({
      window: rateWindowFor(interval),
      mountpoint: escapePromqlString(METRICS_DISK_MOUNTPOINT),
      networkDeviceRegex: escapePromqlString(METRICS_NETWORK_DEVICE_REGEX),
    }),
    format: template.format,
  }
}

const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected an ISO 8601 date')

/**
 * Upper bound on buckets per request. Prometheus itself refuses range queries
 * with more than 11,000 points, so rejecting earlier turns an oversized range
 * into a 400 instead of a wasted round trip and a 502.
 */
const MAX_GRID_POINTS = 11_000

const getInfraMonitoringSchema = z
  .object({
    attributes: z.array(z.enum(INFRA_MONITORING_ATTRIBUTES)).min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    interval: z.enum(METRICS_INTERVALS),
  })
  .superRefine((value, context) => {
    const rangeSeconds = (Date.parse(value.endDate) - Date.parse(value.startDate)) / 1000
    if (rangeSeconds < 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must not be earlier than startDate',
      })
      return
    }
    if (rangeSeconds / stepSecondsFor(value.interval) + 1 > MAX_GRID_POINTS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interval'],
        message: `Range too large for interval ${value.interval}: at most ${MAX_GRID_POINTS} buckets per request`,
      })
    }
  })

export type GetInfraMonitoringVariables = z.input<typeof getInfraMonitoringSchema>

/** Unix seconds for every bucket the response has to cover. */
function buildTimestampGrid(start: Date, end: Date, stepSeconds: number): number[] {
  const startSeconds = Math.floor(start.getTime() / 1000)
  const endSeconds = Math.floor(end.getTime() / 1000)

  const timestamps: number[] = []
  for (let timestamp = startSeconds; timestamp <= endSeconds; timestamp += stepSeconds) {
    timestamps.push(timestamp)
  }
  return timestamps
}

/**
 * Collapses a Prometheus matrix onto the bucket grid. Only the first series is
 * used: every template either aggregates or targets a single host, so extra
 * series would be duplicates rather than separate lines.
 */
function toValuesByTimestamp(series: PrometheusRangeSeries[]): Map<number, number> {
  const values = new Map<number, number>()
  const first = series[0]
  if (first === undefined) return values

  for (const [timestamp, rawValue] of first.values) {
    const value = Number.parseFloat(rawValue)
    // Prometheus emits NaN for gaps in some expressions; treat those as no data.
    if (Number.isFinite(value)) values.set(timestamp, value)
  }
  return values
}

/**
 * A bucket value. `null` means the metric had no samples at all in the range
 * (exporter down, attribute unsupported), which is reported as an absent value
 * rather than a misleading zero. Gaps inside an otherwise present series are
 * filled with zero so charts keep a continuous x axis.
 */
type BucketValue = number | null

function alignToGrid(values: Map<number, number>, timestamps: number[]): BucketValue[] {
  if (values.size === 0) return timestamps.map(() => null)
  return timestamps.map((timestamp) => values.get(timestamp) ?? 0)
}

function toResponseValue(value: BucketValue | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function buildSeriesMetadata(
  values: BucketValue[],
  format: InfraMonitoringFormat
): InfraMonitoringSeriesMetadata {
  const present = values.filter((value): value is number => value !== null)
  const total = present.reduce((sum, value) => sum + value, 0)
  const totalAverage = present.length > 0 ? total / present.length : 0
  const yAxisLimit = format === '%' ? 100 : Math.max(0, ...present)

  return { yAxisLimit, format, total, totalAverage }
}

async function fetchAttributeValues({
  attribute,
  interval,
  startDate,
  endDate,
  timestamps,
}: {
  attribute: SelfHostedInfraMonitoringAttribute
  interval: MetricsInterval
  startDate: Date
  endDate: Date
  timestamps: number[]
}): Promise<BucketValue[]> {
  const query = buildInfraMonitoringQuery(attribute, interval)
  // Unsupported attribute: answer with an absent series rather than an error, so
  // one missing metric does not take down a chart that requests several.
  if (query === null) return timestamps.map(() => null)

  const series = await queryRange({
    query: query.promql,
    start: startDate,
    end: endDate,
    step: stepFor(interval),
  })

  return alignToGrid(toValuesByTimestamp(series), timestamps)
}

function formatOf(attribute: SelfHostedInfraMonitoringAttribute): InfraMonitoringFormat {
  if (isDerivedAttribute(attribute)) return DERIVED_ATTRIBUTES[attribute].format
  return INFRA_MONITORING_QUERIES[attribute]?.format ?? 'number'
}

/**
 * Runs the queries for the requested attributes and shapes the result like the
 * platform `infra-monitoring` endpoint: a flat object for a single attribute, a
 * `values` map plus a `series` index for several.
 */
export async function getInfraMonitoring(
  variables: GetInfraMonitoringVariables
): Promise<InfraMonitoringResponse> {
  assertSelfHosted()

  const { attributes, startDate, endDate, interval } = getInfraMonitoringSchema.parse(variables)

  const start = new Date(startDate)
  const end = new Date(endDate)
  const timestamps = buildTimestampGrid(start, end, stepSecondsFor(interval))

  // Derived attributes are expanded into the attributes they are computed from,
  // so each underlying query is issued exactly once.
  const queriedAttributes = new Set<SelfHostedInfraMonitoringAttribute>()
  for (const attribute of attributes) {
    if (isDerivedAttribute(attribute)) {
      for (const input of DERIVED_ATTRIBUTES[attribute].inputs) queriedAttributes.add(input)
    } else {
      queriedAttributes.add(attribute)
    }
  }

  const queried = [...queriedAttributes]
  const results = await Promise.all(
    queried.map((attribute) =>
      fetchAttributeValues({ attribute, interval, startDate: start, endDate: end, timestamps })
    )
  )

  const valuesByAttribute = new Map<SelfHostedInfraMonitoringAttribute, BucketValue[]>()
  queried.forEach((attribute, index) => valuesByAttribute.set(attribute, results[index]))

  for (const attribute of attributes) {
    if (!isDerivedAttribute(attribute)) continue

    const [usedKey, databaseKey, walKey] = DERIVED_ATTRIBUTES[attribute].inputs
    const used = valuesByAttribute.get(usedKey) ?? []
    const database = valuesByAttribute.get(databaseKey) ?? []
    const wal = valuesByAttribute.get(walKey) ?? []

    // The derived value is absent whenever the filesystem figure it starts from
    // is absent; missing database or WAL sizes just do not get subtracted.
    valuesByAttribute.set(
      attribute,
      timestamps.map((_, index) => {
        const usedValue = used[index]
        if (usedValue === null || usedValue === undefined) return null
        return Math.max(0, usedValue - (database[index] ?? 0) - (wal[index] ?? 0))
      })
    )
  }

  const periodStarts = timestamps.map((timestamp) => new Date(timestamp * 1000).toISOString())
  const absent: BucketValue[] = timestamps.map(() => null)

  if (attributes.length === 1) {
    const attribute = attributes[0]
    const values = valuesByAttribute.get(attribute) ?? absent

    const response: InfraMonitoringSingleResponse = {
      ...buildSeriesMetadata(values, formatOf(attribute)),
      data: periodStarts.map((periodStart, index) => ({
        period_start: periodStart,
        [attribute]: toResponseValue(values[index]),
      })),
    }
    return response
  }

  const response: InfraMonitoringMultiResponse = {
    data: periodStarts.map((periodStart, index) => ({
      period_start: periodStart,
      values: Object.fromEntries(
        attributes.map((attribute) => [
          attribute,
          toResponseValue((valuesByAttribute.get(attribute) ?? absent)[index]),
        ])
      ),
    })),
    series: Object.fromEntries(
      attributes.map((attribute) => [
        attribute,
        buildSeriesMetadata(valuesByAttribute.get(attribute) ?? absent, formatOf(attribute)),
      ])
    ),
  }
  return response
}
