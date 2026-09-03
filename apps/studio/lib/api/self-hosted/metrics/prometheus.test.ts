import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PrometheusError, queryRange, rateWindowFor, stepFor, stepSecondsFor } from './prometheus'

vi.mock('../constants', () => ({
  METRICS_PROMETHEUS_URL: 'http://prometheus:9090',
  METRICS_TIMEOUT_MS: 5000,
}))

const matrixResponse = (result: unknown[]) =>
  new Response(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** Mirrors what undici throws when nothing is listening on the target port. */
const connectionRefusedError = () => {
  const cause = new Error('connect ECONNREFUSED 172.18.0.9:9090')
  Object.assign(cause, { code: 'ECONNREFUSED' })
  return new TypeError('fetch failed', { cause })
}

/** Mirrors what AbortSignal.timeout aborts with. */
const timeoutError = () => new DOMException('The operation was aborted', 'TimeoutError')

const start = new Date('2026-01-01T00:00:00.000Z')
const end = new Date('2026-01-01T00:05:00.000Z')

describe('api/self-hosted/metrics/prometheus', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('stepFor / rateWindowFor / stepSecondsFor', () => {
    it('returns the step matching the interval', () => {
      expect(stepFor('1m')).toBe('1m')
      expect(stepFor('1h')).toBe('1h')
      expect(stepFor('1d')).toBe('1d')
    })

    it('widens the rate window past the step for the finest interval', () => {
      expect(rateWindowFor('1m')).toBe('5m')
      expect(rateWindowFor('1h')).toBe('1h')
      expect(rateWindowFor('1d')).toBe('1d')
    })

    it('returns the step length in seconds', () => {
      expect(stepSecondsFor('1m')).toBe(60)
      expect(stepSecondsFor('1h')).toBe(3600)
      expect(stepSecondsFor('1d')).toBe(86400)
    })
  })

  describe('queryRange', () => {
    it('returns the parsed matrix series', async () => {
      mockFetch.mockResolvedValue(
        matrixResponse([{ metric: { instance: 'node:9100' }, values: [[1767225600, '12.5']] }])
      )

      const series = await queryRange({ query: 'up', start, end, step: '1m' })

      expect(series).toEqual([
        { metric: { instance: 'node:9100' }, values: [[1767225600, '12.5']] },
      ])
    })

    it('sends the query, the range and the step as query parameters', async () => {
      mockFetch.mockResolvedValue(matrixResponse([]))

      await queryRange({ query: 'sum(rate(up[5m]))', start, end, step: '1m' })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, init] = mockFetch.mock.calls[0]
      const parsed = new URL(url)

      expect(parsed.origin + parsed.pathname).toBe('http://prometheus:9090/api/v1/query_range')
      expect(parsed.searchParams.get('query')).toBe('sum(rate(up[5m]))')
      expect(parsed.searchParams.get('start')).toBe(String(start.getTime() / 1000))
      expect(parsed.searchParams.get('end')).toBe(String(end.getTime() / 1000))
      expect(parsed.searchParams.get('step')).toBe('1m')
      expect(init.method).toBe('GET')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('reports a timeout without leaking the request URL', async () => {
      mockFetch.mockRejectedValue(timeoutError())

      await expect(queryRange({ query: 'up', start, end, step: '1m' })).rejects.toThrowError(
        new PrometheusError('Timed out after 5000ms')
      )
    })

    it('reports a refused connection', async () => {
      mockFetch.mockRejectedValue(connectionRefusedError())

      await expect(queryRange({ query: 'up', start, end, step: '1m' })).rejects.toThrowError(
        new PrometheusError('Connection refused')
      )
    })

    it('does not echo the failing URL, which may carry credentials', async () => {
      mockFetch.mockRejectedValue(
        new TypeError('Failed to parse URL from http://user:hunter2@prometheus:9090/api/v1')
      )

      await expect(
        queryRange({ query: 'up', start, end, step: '1m' })
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[PrometheusError: Could not reach Prometheus]`)
    })

    it('reports the status code for a failed HTTP response', async () => {
      mockFetch.mockResolvedValue(new Response('boom', { status: 500 }))

      await expect(queryRange({ query: 'up', start, end, step: '1m' })).rejects.toThrowError(
        new PrometheusError('Prometheus responded with HTTP 500')
      )
    })

    it('rejects a body that is not a Prometheus matrix response', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector' } }), {
          status: 200,
        })
      )

      await expect(queryRange({ query: 'up', start, end, step: '1m' })).rejects.toThrowError(
        new PrometheusError('Prometheus returned an unexpected response')
      )
    })

    it('rejects a Prometheus error envelope', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ status: 'error', errorType: 'bad_data' }), { status: 200 })
      )

      await expect(queryRange({ query: 'up', start, end, step: '1m' })).rejects.toThrowError(
        new PrometheusError('Prometheus returned an unexpected response')
      )
    })

    it('rejects a body that is not JSON', async () => {
      mockFetch.mockResolvedValue(new Response('<html>', { status: 200 }))

      await expect(queryRange({ query: 'up', start, end, step: '1m' })).rejects.toThrowError(
        new PrometheusError('Prometheus returned a malformed response')
      )
    })
  })
})
