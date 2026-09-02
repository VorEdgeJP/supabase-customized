import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkAllServices, checkDatabase, checkHttpService } from './service-health'
import { SELF_HOSTED_SERVICE_NAMES } from './service-health.types'

vi.mock('./util', () => ({
  assertSelfHosted: vi.fn(),
}))

vi.mock('./query', () => ({
  executeQuery: vi.fn(),
}))

const okResponse = () => new Response('{}', { status: 200 })

/** Mirrors what undici throws when nothing is listening on the target port. */
const connectionRefusedError = () => {
  const cause = new Error('connect ECONNREFUSED 172.18.0.5:9999')
  Object.assign(cause, { code: 'ECONNREFUSED' })
  return new TypeError('fetch failed', { cause })
}

/** Mirrors what AbortSignal.timeout aborts with. */
const timeoutError = () => new DOMException('The operation was aborted', 'TimeoutError')

describe('api/self-hosted/service-health', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('checkHttpService', () => {
    it('reports ACTIVE_HEALTHY for a 200 response', async () => {
      mockFetch.mockResolvedValue(okResponse())

      const result = await checkHttpService({ name: 'auth', url: 'http://auth:9999/health' })

      expect(result.name).toBe('auth')
      expect(result.status).toBe('ACTIVE_HEALTHY')
      expect(typeof result.latencyMs).toBe('number')
      expect(result.error).toBeUndefined()
      expect(typeof result.checkedAt).toBe('string')
    })

    it('passes the timeout signal and any headers to fetch', async () => {
      mockFetch.mockResolvedValue(okResponse())

      await checkHttpService({
        name: 'realtime',
        url: 'http://realtime:4000/health',
        headers: { Authorization: 'Bearer anon-key' },
      })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe('http://realtime:4000/health')
      expect(init.method).toBe('GET')
      expect(init.headers).toEqual({ Authorization: 'Bearer anon-key' })
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('reports UNHEALTHY with the status code for a 503 response', async () => {
      mockFetch.mockResolvedValue(new Response('unavailable', { status: 503 }))

      const result = await checkHttpService({ name: 'storage', url: 'http://storage:5000/status' })

      expect(result.status).toBe('UNHEALTHY')
      expect(result.error).toBe('Responded with HTTP 503')
      expect(typeof result.latencyMs).toBe('number')
    })

    it('reports ACTIVE_HEALTHY for a non-2xx response when acceptAnyResponse is set', async () => {
      mockFetch.mockResolvedValue(new Response('not found', { status: 404 }))

      const result = await checkHttpService({
        name: 'functions',
        url: 'http://functions:9000/',
        acceptAnyResponse: true,
      })

      expect(result.status).toBe('ACTIVE_HEALTHY')
      expect(result.error).toBeUndefined()
    })

    it('reports UNHEALTHY when the connection is refused', async () => {
      mockFetch.mockRejectedValue(connectionRefusedError())

      const result = await checkHttpService({ name: 'auth', url: 'http://auth:9999/health' })

      expect(result.status).toBe('UNHEALTHY')
      expect(result.error).toBe('Connection refused')
      expect(result.latencyMs).toBeNull()
    })

    it('reports UNHEALTHY when the request times out', async () => {
      mockFetch.mockRejectedValue(timeoutError())

      const result = await checkHttpService({ name: 'pooler', url: 'http://supavisor:4000/health' })

      expect(result.status).toBe('UNHEALTHY')
      expect(result.error).toBe('Timed out after 3000ms')
      expect(result.latencyMs).toBeNull()
    })

    it('reports UNHEALTHY without fetching when the configured URL is malformed', async () => {
      const result = await checkHttpService({ name: 'auth', url: 'http://user:pass@:::/health' })

      expect(result.status).toBe('UNHEALTHY')
      expect(result.error).toBe('Invalid health check URL')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('reports DISABLED without fetching when the URL is empty', async () => {
      const result = await checkHttpService({ name: 'pooler', url: '' })

      expect(result.status).toBe('DISABLED')
      expect(result.latencyMs).toBeNull()
      expect(result.error).toBeUndefined()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('checkDatabase', () => {
    it('reports ACTIVE_HEALTHY and the Postgres version on success', async () => {
      const { executeQuery } = await import('./query')
      vi.mocked(executeQuery).mockResolvedValue({
        data: [{ version: 'PostgreSQL 15.8 on x86_64-pc-linux-gnu' }],
        error: undefined,
      })

      const result = await checkDatabase()

      expect(result.name).toBe('db')
      expect(result.status).toBe('ACTIVE_HEALTHY')
      expect(result.info).toEqual({ version: 'PostgreSQL 15.8 on x86_64-pc-linux-gnu' })
      expect(vi.mocked(executeQuery)).toHaveBeenCalledWith({
        query: 'select version()',
        readOnly: true,
      })
    })

    it('reports UNHEALTHY when pg-meta returns an error', async () => {
      const { executeQuery } = await import('./query')
      vi.mocked(executeQuery).mockResolvedValue({
        data: undefined,
        error: new Error('relation does not exist'),
      })

      const result = await checkDatabase()

      expect(result.status).toBe('UNHEALTHY')
      expect(result.error).toContain('pg-meta')
      expect(result.error).toContain('relation does not exist')
    })

    it('reports UNHEALTHY when the query does not answer within the timeout', async () => {
      vi.useFakeTimers()
      const { executeQuery } = await import('./query')
      vi.mocked(executeQuery).mockReturnValue(new Promise(() => {}))

      try {
        const resultPromise = checkDatabase()
        await vi.advanceTimersByTimeAsync(3000)
        const result = await resultPromise

        expect(result.status).toBe('UNHEALTHY')
        expect(result.error).toBe('Timed out after 3000ms')
        expect(result.latencyMs).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('reports UNHEALTHY when pg-meta itself is unreachable', async () => {
      const { executeQuery } = await import('./query')
      vi.mocked(executeQuery).mockRejectedValue(connectionRefusedError())

      const result = await checkDatabase()

      expect(result.status).toBe('UNHEALTHY')
      expect(result.error).toBe('Could not reach the database through pg-meta: Connection refused')
      expect(result.latencyMs).toBeNull()
    })
  })

  describe('checkAllServices', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValue(okResponse())
      const { executeQuery } = await import('./query')
      vi.mocked(executeQuery).mockResolvedValue({
        data: [{ version: 'PostgreSQL 15.8' }],
        error: undefined,
      })
    })

    it('asserts the environment is self-hosted', async () => {
      const { assertSelfHosted } = await import('./util')

      await checkAllServices(['auth'])

      expect(vi.mocked(assertSelfHosted)).toHaveBeenCalled()
    })

    it('checks every service by default', async () => {
      const results = await checkAllServices()

      expect(results.map((service) => service.name)).toEqual([...SELF_HOSTED_SERVICE_NAMES])
      expect(results.every((service) => service.status === 'ACTIVE_HEALTHY')).toBe(true)
    })

    it('checks only the requested services, in the requested order', async () => {
      const results = await checkAllServices(['storage', 'auth'])

      expect(results.map((service) => service.name)).toEqual(['storage', 'auth'])
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('keeps reporting the other services when one of them fails', async () => {
      mockFetch.mockImplementation((url: string) =>
        url.includes('auth')
          ? Promise.reject(connectionRefusedError())
          : Promise.resolve(okResponse())
      )

      const results = await checkAllServices(['auth', 'storage'])

      expect(results[0]).toMatchObject({
        name: 'auth',
        status: 'UNHEALTHY',
        error: 'Connection refused',
      })
      expect(results[1]).toMatchObject({ name: 'storage', status: 'ACTIVE_HEALTHY' })
    })
  })
})
