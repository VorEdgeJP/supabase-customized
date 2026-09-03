import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildInfraMonitoringQuery,
  escapePromqlString,
  getInfraMonitoring,
  INFRA_MONITORING_ATTRIBUTES,
  type GetInfraMonitoringVariables,
  type SelfHostedInfraMonitoringAttribute,
} from './infra-monitoring'
import { queryRange, type PrometheusRangeSeries } from './prometheus'
import type {
  InfraMonitoringMultiResponse,
  InfraMonitoringSingleResponse,
} from '@/data/analytics/infra-monitoring-query'

vi.mock('../constants', () => ({
  METRICS_PROMETHEUS_URL: 'http://prometheus:9090',
  METRICS_TIMEOUT_MS: 5000,
  METRICS_DISK_MOUNTPOINT: '/',
  METRICS_NETWORK_DEVICE_REGEX: '^(eth|en|ens|enp).*',
}))

vi.mock('../util', () => ({
  assertSelfHosted: vi.fn(),
}))

vi.mock('./prometheus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prometheus')>()),
  queryRange: vi.fn(),
}))

const mockedQueryRange = vi.mocked(queryRange)

const FS_SELECTOR = '{mountpoint="/",fstype!~"tmpfs|overlay"}'

/** Expected PromQL for every attribute Prometheus can answer, at interval `1m`. */
const EXPECTED_PROMQL: Record<string, string> = {
  cpu_usage: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  avg_cpu_usage: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  max_cpu_usage: '100 * (1 - min(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  cpu_usage_busy_system:
    '100 * sum(rate(node_cpu_seconds_total{mode="system"}[5m])) / sum(rate(node_cpu_seconds_total[5m]))',
  cpu_usage_busy_user:
    '100 * sum(rate(node_cpu_seconds_total{mode="user"}[5m])) / sum(rate(node_cpu_seconds_total[5m]))',
  cpu_usage_busy_iowait:
    '100 * sum(rate(node_cpu_seconds_total{mode="iowait"}[5m])) / sum(rate(node_cpu_seconds_total[5m]))',
  cpu_usage_busy_irqs:
    '100 * sum(rate(node_cpu_seconds_total{mode=~"irq|softirq"}[5m])) / sum(rate(node_cpu_seconds_total[5m]))',
  cpu_usage_busy_other:
    '100 * sum(rate(node_cpu_seconds_total{mode=~"nice|steal"}[5m])) / sum(rate(node_cpu_seconds_total[5m]))',
  cpu_usage_busy_idle:
    '100 * sum(rate(node_cpu_seconds_total{mode="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m]))',
  ram_usage: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
  ram_usage_total: 'node_memory_MemTotal_bytes',
  ram_usage_available: 'node_memory_MemAvailable_bytes',
  ram_usage_free: 'node_memory_MemFree_bytes',
  ram_usage_used: 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes',
  ram_usage_cache_and_buffers: 'node_memory_Cached_bytes + node_memory_Buffers_bytes',
  ram_usage_swap: 'node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes',
  swap_usage:
    '100 * (1 - node_memory_SwapFree_bytes / clamp_min(node_memory_SwapTotal_bytes, 1)) * (node_memory_SwapTotal_bytes > bool 0)',
  disk_fs_size: `node_filesystem_size_bytes${FS_SELECTOR}`,
  disk_fs_avail: `node_filesystem_avail_bytes${FS_SELECTOR}`,
  disk_fs_used: `node_filesystem_size_bytes${FS_SELECTOR} - node_filesystem_avail_bytes${FS_SELECTOR}`,
  disk_fs_used_wal: 'sum(pg_wal_size_bytes)',
  pg_database_size: 'sum(pg_database_size_bytes)',
  disk_iops_read: 'sum(rate(node_disk_reads_completed_total{device!~"loop.*|dm-.*"}[5m]))',
  disk_iops_write: 'sum(rate(node_disk_writes_completed_total{device!~"loop.*|dm-.*"}[5m]))',
  disk_bytes_read: 'sum(rate(node_disk_read_bytes_total{device!~"loop.*|dm-.*"}[5m]))',
  disk_bytes_written: 'sum(rate(node_disk_written_bytes_total{device!~"loop.*|dm-.*"}[5m]))',
  network_receive_bytes:
    'sum(rate(node_network_receive_bytes_total{device=~"^(eth|en|ens|enp).*"}[5m]))',
  network_transmit_bytes:
    'sum(rate(node_network_transmit_bytes_total{device=~"^(eth|en|ens|enp).*"}[5m]))',
  pg_stat_database_num_backends: 'sum(pg_stat_database_numbackends)',
  max_db_connections: 'pg_settings_max_connections',
}

/** Attributes that intentionally have no query: unsupported, or derived in code. */
const ATTRIBUTES_WITHOUT_QUERY: SelfHostedInfraMonitoringAttribute[] = [
  'ram_commit_used',
  'ram_commit_limit',
  'client_connections_pgbouncer',
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
  'physical_replication_lag_physical_replication_lag_seconds',
  'disk_fs_used_system',
]

const START = '2026-01-01T00:00:00.000Z'
const END = '2026-01-01T00:02:00.000Z'
const BUCKETS = [
  Date.parse(START) / 1000,
  Date.parse(START) / 1000 + 60,
  Date.parse(START) / 1000 + 120,
]
const PERIOD_STARTS = [
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:01:00.000Z',
  '2026-01-01T00:02:00.000Z',
]

const series = (values: Array<[number, string]>): PrometheusRangeSeries[] => [
  { metric: {}, values },
]

describe('api/self-hosted/metrics/infra-monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
  })

  describe('escapePromqlString', () => {
    it('escapes backslashes, double quotes and newlines', () => {
      expect(escapePromqlString('/mnt/da"ta')).toBe('/mnt/da\\"ta')
      expect(escapePromqlString('C:\\data')).toBe('C:\\\\data')
      expect(escapePromqlString('a\nb')).toBe('a\\nb')
      expect(escapePromqlString('/')).toBe('/')
    })
  })

  describe('buildInfraMonitoringQuery', () => {
    it.each(Object.keys(EXPECTED_PROMQL))('builds the query for %s', (attribute) => {
      const query = buildInfraMonitoringQuery(attribute as SelfHostedInfraMonitoringAttribute, '1m')

      expect(query?.promql).toBe(EXPECTED_PROMQL[attribute])
      expect(['%', 'bytes', 'number']).toContain(query?.format)
    })

    it('substitutes the rate window for the requested interval', () => {
      expect(buildInfraMonitoringQuery('cpu_usage', '1h')?.promql).toBe(
        '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[1h])))'
      )
      expect(buildInfraMonitoringQuery('cpu_usage', '1d')?.promql).toBe(
        '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[1d])))'
      )
    })

    it.each(ATTRIBUTES_WITHOUT_QUERY)('returns null for %s', (attribute) => {
      expect(buildInfraMonitoringQuery(attribute, '1m')).toBeNull()
    })

    it('covers every allowlisted attribute', () => {
      const covered = new Set([...Object.keys(EXPECTED_PROMQL), ...ATTRIBUTES_WITHOUT_QUERY])
      expect([...INFRA_MONITORING_ATTRIBUTES].filter((name) => !covered.has(name))).toEqual([])
    })

    it('escapes the configured mountpoint into the PromQL string literal', async () => {
      vi.resetModules()
      vi.doMock('../constants', () => ({
        METRICS_PROMETHEUS_URL: 'http://prometheus:9090',
        METRICS_TIMEOUT_MS: 5000,
        METRICS_DISK_MOUNTPOINT: '/mnt/da"ta\\vol',
        METRICS_NETWORK_DEVICE_REGEX: 'eth"0',
      }))

      const reloaded = await import('./infra-monitoring')

      expect(reloaded.buildInfraMonitoringQuery('disk_fs_avail', '1m')?.promql).toBe(
        'node_filesystem_avail_bytes{mountpoint="/mnt/da\\"ta\\\\vol",fstype!~"tmpfs|overlay"}'
      )
      expect(reloaded.buildInfraMonitoringQuery('network_receive_bytes', '1m')?.promql).toBe(
        'sum(rate(node_network_receive_bytes_total{device=~"eth\\"0"}[5m]))'
      )

      vi.doUnmock('../constants')
    })
  })

  describe('getInfraMonitoring', () => {
    it('returns the single-attribute shape and fills gaps with zero', async () => {
      mockedQueryRange.mockResolvedValue(
        series([
          [BUCKETS[0], '20'],
          [BUCKETS[2], '40'],
        ])
      )

      const response = (await getInfraMonitoring({
        attributes: ['ram_usage'],
        startDate: START,
        endDate: END,
        interval: '1m',
      })) as InfraMonitoringSingleResponse

      expect(response.data).toEqual([
        { period_start: PERIOD_STARTS[0], ram_usage: '20' },
        { period_start: PERIOD_STARTS[1], ram_usage: '0' },
        { period_start: PERIOD_STARTS[2], ram_usage: '40' },
      ])
      expect(response.format).toBe('%')
      expect(response.yAxisLimit).toBe(100)
      expect(response.total).toBe(60)
      expect(response.totalAverage).toBe(20)
    })

    it('passes the range and step through to Prometheus', async () => {
      mockedQueryRange.mockResolvedValue([])

      await getInfraMonitoring({
        attributes: ['ram_usage_total'],
        startDate: START,
        endDate: END,
        interval: '1m',
      })

      expect(mockedQueryRange).toHaveBeenCalledTimes(1)
      expect(mockedQueryRange).toHaveBeenCalledWith({
        query: 'node_memory_MemTotal_bytes',
        start: new Date(START),
        end: new Date(END),
        step: '1m',
      })
    })

    it('returns the multi-attribute shape with per-series metadata', async () => {
      mockedQueryRange.mockImplementation(async ({ query }) => {
        if (query === 'node_memory_MemTotal_bytes') {
          return series([
            [BUCKETS[0], '100'],
            [BUCKETS[1], '100'],
            [BUCKETS[2], '100'],
          ])
        }
        return series([
          [BUCKETS[0], '2'],
          [BUCKETS[1], '4'],
          [BUCKETS[2], '6'],
        ])
      })

      const response = (await getInfraMonitoring({
        attributes: ['ram_usage_total', 'pg_stat_database_num_backends'],
        startDate: START,
        endDate: END,
        interval: '1m',
      })) as InfraMonitoringMultiResponse

      expect(response.data).toEqual([
        {
          period_start: PERIOD_STARTS[0],
          values: { ram_usage_total: '100', pg_stat_database_num_backends: '2' },
        },
        {
          period_start: PERIOD_STARTS[1],
          values: { ram_usage_total: '100', pg_stat_database_num_backends: '4' },
        },
        {
          period_start: PERIOD_STARTS[2],
          values: { ram_usage_total: '100', pg_stat_database_num_backends: '6' },
        },
      ])
      expect(response.series).toEqual({
        ram_usage_total: { yAxisLimit: 100, format: 'bytes', total: 300, totalAverage: 100 },
        pg_stat_database_num_backends: {
          yAxisLimit: 6,
          format: 'number',
          total: 12,
          totalAverage: 4,
        },
      })
    })

    it('returns an absent series for an unsupported attribute without querying', async () => {
      mockedQueryRange.mockResolvedValue([])

      const response = (await getInfraMonitoring({
        attributes: ['disk_io_budget'],
        startDate: START,
        endDate: END,
        interval: '1m',
      })) as InfraMonitoringSingleResponse

      expect(mockedQueryRange).not.toHaveBeenCalled()
      expect(response.data).toEqual([
        { period_start: PERIOD_STARTS[0], disk_io_budget: undefined },
        { period_start: PERIOD_STARTS[1], disk_io_budget: undefined },
        { period_start: PERIOD_STARTS[2], disk_io_budget: undefined },
      ])
      expect(response.total).toBe(0)
      expect(response.totalAverage).toBe(0)
      expect(response.yAxisLimit).toBe(0)
    })

    it('derives disk_fs_used_system from its inputs and clamps it at zero', async () => {
      mockedQueryRange.mockImplementation(async ({ query }) => {
        if (query.startsWith('node_filesystem_size_bytes')) {
          return series([
            [BUCKETS[0], '1000'],
            [BUCKETS[1], '1000'],
            [BUCKETS[2], '1000'],
          ])
        }
        if (query === 'sum(pg_database_size_bytes)') {
          return series([
            [BUCKETS[0], '400'],
            [BUCKETS[1], '900'],
            [BUCKETS[2], '100'],
          ])
        }
        return series([
          [BUCKETS[0], '100'],
          [BUCKETS[1], '300'],
          [BUCKETS[2], '100'],
        ])
      })

      const response = (await getInfraMonitoring({
        attributes: ['disk_fs_used_system'],
        startDate: START,
        endDate: END,
        interval: '1m',
      })) as InfraMonitoringSingleResponse

      // 1000 - 400 - 100, 1000 - 900 - 300 (clamped), 1000 - 100 - 100
      expect(response.data.map((entry) => entry.disk_fs_used_system)).toEqual(['500', '0', '800'])
      expect(mockedQueryRange).toHaveBeenCalledTimes(3)
      expect(response.format).toBe('bytes')
      expect(response.yAxisLimit).toBe(800)
    })

    it('reports a metric with no samples at all as absent, not zero', async () => {
      mockedQueryRange.mockImplementation(async ({ query }) =>
        query.includes('node_cpu_seconds_total') ? [] : series([[BUCKETS[1], '42']])
      )

      const response = (await getInfraMonitoring({
        attributes: ['avg_cpu_usage', 'ram_usage'],
        startDate: START,
        endDate: END,
        interval: '1m',
      })) as InfraMonitoringMultiResponse

      expect(response.data.map((entry) => entry.values.avg_cpu_usage)).toEqual([
        undefined,
        undefined,
        undefined,
      ])
      // A gap inside a present series is still filled with zero.
      expect(response.data.map((entry) => entry.values.ram_usage)).toEqual(['0', '42', '0'])
      expect(response.series.avg_cpu_usage).toMatchObject({ total: 0, totalAverage: 0 })
      expect(response.series.ram_usage).toMatchObject({ total: 42, totalAverage: 14 })
    })

    it('rejects a range with more buckets than Prometheus accepts', async () => {
      await expect(
        getInfraMonitoring({
          attributes: ['ram_usage'],
          startDate: START,
          // 8 days at 1-minute resolution is about 11,520 buckets.
          endDate: '2026-01-09T00:00:00.000Z',
          interval: '1m',
        })
      ).rejects.toThrowError(/at most 11000 buckets/)

      await expect(
        getInfraMonitoring({
          attributes: ['ram_usage'],
          startDate: END,
          endDate: START,
          interval: '1m',
        })
      ).rejects.toThrowError(/endDate/)
      expect(mockedQueryRange).not.toHaveBeenCalled()
    })

    it('rejects an unknown attribute', async () => {
      await expect(
        getInfraMonitoring({
          attributes: ['not_a_metric'],
          startDate: START,
          endDate: END,
          interval: '1m',
        } as unknown as GetInfraMonitoringVariables)
      ).rejects.toThrowError(/attributes/)
      expect(mockedQueryRange).not.toHaveBeenCalled()
    })

    it('rejects an empty attribute list, a bad date and a bad interval', async () => {
      await expect(
        getInfraMonitoring({ attributes: [], startDate: START, endDate: END, interval: '1m' })
      ).rejects.toThrowError()

      await expect(
        getInfraMonitoring({
          attributes: ['ram_usage'],
          startDate: 'yesterday',
          endDate: END,
          interval: '1m',
        })
      ).rejects.toThrowError(/ISO 8601/)

      await expect(
        getInfraMonitoring({
          attributes: ['ram_usage'],
          startDate: START,
          endDate: END,
          interval: '30m',
        } as unknown as GetInfraMonitoringVariables)
      ).rejects.toThrowError()
    })
  })
})
