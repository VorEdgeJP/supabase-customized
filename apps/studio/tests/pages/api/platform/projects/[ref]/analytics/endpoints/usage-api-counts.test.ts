import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../../../../../pages/api/platform/projects/[ref]/analytics/endpoints/[name]'
import type { MetricsRequestsSource } from '@/lib/api/self-hosted/constants'
import { retrieveAnalyticsData } from '@/lib/api/self-hosted/logs'
import { PrometheusError, queryRange } from '@/lib/api/self-hosted/metrics/prometheus'

const { config } = vi.hoisted(() => ({
  config: { requestsSource: 'prometheus' as MetricsRequestsSource },
}))

vi.mock('@/lib/api/self-hosted/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-hosted/constants')>()),
  METRICS_GATEWAY: 'envoy',
  get METRICS_REQUESTS_SOURCE() {
    return config.requestsSource
  },
}))

vi.mock('@/lib/api/self-hosted/logs', () => ({
  retrieveAnalyticsData: vi.fn(),
}))

vi.mock('@/lib/api/self-hosted/metrics/prometheus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-hosted/metrics/prometheus')>()),
  queryRange: vi.fn(),
}))

const query = (overrides: Record<string, string> = {}) => ({
  ref: 'default',
  name: 'usage.api-counts',
  interval: '1day',
  ...overrides,
})

describe('/api/platform/projects/[ref]/analytics/endpoints/[name] — usage.api-counts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.requestsSource = 'prometheus'
    vi.mocked(queryRange).mockResolvedValue([])
    vi.mocked(retrieveAnalyticsData).mockResolvedValue({ data: { result: [] }, error: undefined })
  })

  describe('Method handling', () => {
    it('returns 405 for methods other than GET and POST', async () => {
      const { req, res } = createMocks({ method: 'PUT', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(405)
      expect(res.getHeader('Allow')).toEqual(['GET', 'POST'])
    })
  })

  describe('Prometheus branch', () => {
    it('answers from Prometheus without calling Logflare', async () => {
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData()).result).toHaveLength(24)
      // Two queries per service: the complete buckets and the one in progress.
      expect(vi.mocked(queryRange)).toHaveBeenCalledTimes(8)
      expect(vi.mocked(retrieveAnalyticsData)).not.toHaveBeenCalled()
    })

    it('returns 400 for an interval that is not on the allowlist', async () => {
      const { req, res } = createMocks({ method: 'GET', query: query({ interval: '30day' }) })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toContain('1hr, 1day, 7day')
      expect(vi.mocked(queryRange)).not.toHaveBeenCalled()
    })

    it('returns 502 with a normalized message when Prometheus fails', async () => {
      vi.mocked(queryRange).mockRejectedValue(new PrometheusError('Connection refused'))
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
      expect(JSON.parse(res._getData())).toEqual({ error: { message: 'Connection refused' } })
    })

    it('never echoes the Prometheus URL for an unexpected failure', async () => {
      vi.mocked(queryRange).mockRejectedValue(
        new Error('connect ECONNREFUSED http://user:pass@prometheus:9090')
      )
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(500)
      expect(res._getData()).not.toContain('prometheus:9090')
    })
  })

  describe('Logflare forwarding', () => {
    it('forwards usage.api-counts when the requests source is Logflare', async () => {
      config.requestsSource = 'logflare'
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(queryRange)).not.toHaveBeenCalled()
      expect(vi.mocked(retrieveAnalyticsData)).toHaveBeenCalledWith({
        name: 'usage.api-counts',
        projectRef: 'default',
        params: { interval: '1day' },
      })
    })

    it('forwards every other endpoint even when Prometheus is the requests source', async () => {
      const { req, res } = createMocks({
        method: 'GET',
        query: query({ name: 'functions.req-stats' }),
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(queryRange)).not.toHaveBeenCalled()
      expect(vi.mocked(retrieveAnalyticsData)).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'functions.req-stats' })
      )
    })

    it('forwards a POST, which the Prometheus branch never handles', async () => {
      const { req, res } = createMocks({
        method: 'POST',
        query: query(),
        body: { interval: '1day' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(queryRange)).not.toHaveBeenCalled()
      expect(vi.mocked(retrieveAnalyticsData)).toHaveBeenCalled()
    })
  })
})
