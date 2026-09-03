import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../../../pages/api/platform/projects/[ref]/infra-monitoring'
import { isSelfHostedMetricsEnabled } from '@/lib/api/self-hosted/constants'
import { getInfraMonitoring } from '@/lib/api/self-hosted/metrics/infra-monitoring'
import { PrometheusError } from '@/lib/api/self-hosted/metrics/prometheus'

vi.mock('@/lib/api/self-hosted/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-hosted/constants')>()),
  isSelfHostedMetricsEnabled: vi.fn(),
}))

vi.mock('@/lib/api/self-hosted/metrics/infra-monitoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-hosted/metrics/infra-monitoring')>()),
  getInfraMonitoring: vi.fn(),
}))

const SINGLE_ATTRIBUTE_RESPONSE = {
  data: [{ period_start: '2026-09-03T00:00:00.000Z', cpu_usage: '12' }],
  yAxisLimit: 100,
  format: '%',
  total: 12,
  totalAverage: 12,
}

const query = (overrides: Record<string, string | string[]> = {}) => ({
  ref: 'default',
  attributes: 'cpu_usage',
  startDate: '2026-09-03T00:00:00.000Z',
  endDate: '2026-09-03T00:05:00.000Z',
  interval: '1m',
  ...overrides,
})

describe('/api/platform/projects/[ref]/infra-monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isSelfHostedMetricsEnabled).mockReturnValue(true)
    vi.mocked(getInfraMonitoring).mockResolvedValue(SINGLE_ATTRIBUTE_RESPONSE)
  })

  describe('Method handling', () => {
    it('should return 405 for non-GET methods', async () => {
      const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(405)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Method POST Not Allowed' },
      })
      expect(res.getHeader('Allow')).toEqual(['GET'])
    })
  })

  describe('GET without metrics configured', () => {
    it('returns the empty payload and never queries Prometheus', async () => {
      vi.mocked(isSelfHostedMetricsEnabled).mockReturnValue(false)
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual({
        data: [],
        yAxisLimit: 0,
        format: '%',
        total: 0,
      })
      expect(vi.mocked(getInfraMonitoring)).not.toHaveBeenCalled()
    })
  })

  describe('GET with metrics configured', () => {
    it('returns the metrics response for a single attribute', async () => {
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual(SINGLE_ATTRIBUTE_RESPONSE)
      expect(vi.mocked(getInfraMonitoring)).toHaveBeenCalledWith({
        attributes: ['cpu_usage'],
        startDate: '2026-09-03T00:00:00.000Z',
        endDate: '2026-09-03T00:05:00.000Z',
        interval: '1m',
      })
    })

    it('splits the comma-separated attributes the client sends', async () => {
      const { req, res } = createMocks({
        method: 'GET',
        query: query({ attributes: 'cpu_usage,ram_usage, disk_fs_used' }),
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(getInfraMonitoring)).toHaveBeenCalledWith(
        expect.objectContaining({ attributes: ['cpu_usage', 'ram_usage', 'disk_fs_used'] })
      )
    })

    it('accepts attributes repeated under the bracketed key', async () => {
      const { req, res } = createMocks({
        method: 'GET',
        query: query({ attributes: [], 'attributes[]': ['cpu_usage', 'ram_usage'] }),
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(getInfraMonitoring)).toHaveBeenCalledWith(
        expect.objectContaining({ attributes: ['cpu_usage', 'ram_usage'] })
      )
    })

    it('accepts a repeated attributes key', async () => {
      const { req, res } = createMocks({
        method: 'GET',
        query: query({ attributes: ['cpu_usage', 'ram_usage'] }),
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(getInfraMonitoring)).toHaveBeenCalledWith(
        expect.objectContaining({ attributes: ['cpu_usage', 'ram_usage'] })
      )
    })

    it('takes the first value when a scalar parameter is repeated', async () => {
      const { req, res } = createMocks({
        method: 'GET',
        query: query({ interval: ['1h', '1d'] }),
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(getInfraMonitoring)).toHaveBeenCalledWith(
        expect.objectContaining({ interval: '1h' })
      )
    })

    it('returns 400 for an attribute that is not on the allowlist', async () => {
      const actual = await vi.importActual<
        typeof import('@/lib/api/self-hosted/metrics/infra-monitoring')
      >('@/lib/api/self-hosted/metrics/infra-monitoring')
      vi.mocked(getInfraMonitoring).mockImplementation(actual.getInfraMonitoring)

      const { req, res } = createMocks({
        method: 'GET',
        query: query({ attributes: 'cpu_usage,rm -rf' }),
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toContain('attributes')
    })

    it('returns 400 when a required parameter is missing', async () => {
      const actual = await vi.importActual<
        typeof import('@/lib/api/self-hosted/metrics/infra-monitoring')
      >('@/lib/api/self-hosted/metrics/infra-monitoring')
      vi.mocked(getInfraMonitoring).mockImplementation(actual.getInfraMonitoring)

      const { req, res } = createMocks({
        method: 'GET',
        query: { ref: 'default', attributes: 'cpu_usage', interval: '1m' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toContain('startDate')
    })

    it('returns 502 when Prometheus cannot be reached', async () => {
      vi.mocked(getInfraMonitoring).mockRejectedValue(
        new PrometheusError('Prometheus is unreachable')
      )
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Prometheus is unreachable' },
      })
    })

    it('returns 500 without details for an unexpected failure', async () => {
      vi.mocked(getInfraMonitoring).mockRejectedValue(
        new Error('connect ECONNREFUSED http://user:pass@prometheus:9090')
      )
      const { req, res } = createMocks({ method: 'GET', query: query() })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(500)
      const body = JSON.parse(res._getData())
      expect(body).toEqual({
        data: null,
        error: { message: 'Unable to retrieve infrastructure metrics' },
      })
      expect(res._getData()).not.toContain('prometheus:9090')
    })
  })
})
