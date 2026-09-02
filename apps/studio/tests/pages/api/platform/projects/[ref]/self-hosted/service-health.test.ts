import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../../../../pages/api/platform/projects/[ref]/self-hosted/service-health'
import {
  selfHostedServiceHealthResponseSchema,
  type SelfHostedServiceHealth,
} from '@/lib/api/self-hosted/service-health.types'

vi.mock('@/lib/api/self-hosted/service-health', () => ({
  checkAllServices: vi.fn(),
}))

const healthy = (name: SelfHostedServiceHealth['name']): SelfHostedServiceHealth => ({
  name,
  status: 'ACTIVE_HEALTHY',
  latencyMs: 12,
  checkedAt: '2026-09-02T00:00:00.000Z',
})

describe('/api/platform/projects/[ref]/self-hosted/service-health', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    const { checkAllServices } = await import('@/lib/api/self-hosted/service-health')
    vi.mocked(checkAllServices).mockImplementation(async (names) =>
      (names ?? []).map((name) => healthy(name))
    )
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

  describe('GET', () => {
    it('returns a response matching the shared schema', async () => {
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      const parsed = selfHostedServiceHealthResponseSchema.safeParse(JSON.parse(res._getData()))
      expect(parsed.success).toBe(true)
      expect(parsed.data?.services).toHaveLength(9)
    })

    it('checks every service when no services parameter is given', async () => {
      const { checkAllServices } = await import('@/lib/api/self-hosted/service-health')
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(vi.mocked(checkAllServices)).toHaveBeenCalledWith([
        'db',
        'auth',
        'rest',
        'realtime',
        'storage',
        'functions',
        'meta',
        'pooler',
        'api_gateway',
      ])
    })

    it('checks only the services listed in the query parameter', async () => {
      const { checkAllServices } = await import('@/lib/api/self-hosted/service-health')
      const { req, res } = createMocks({
        method: 'GET',
        query: { ref: 'default', services: 'auth,storage' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(checkAllServices)).toHaveBeenCalledWith(['auth', 'storage'])
      expect(JSON.parse(res._getData()).services).toHaveLength(2)
    })

    it('drops duplicate service names so a request cannot fan out', async () => {
      const { checkAllServices } = await import('@/lib/api/self-hosted/service-health')
      const { req, res } = createMocks({
        method: 'GET',
        query: { ref: 'default', services: 'db,db,auth,db' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(vi.mocked(checkAllServices)).toHaveBeenCalledWith(['db', 'auth'])
    })

    it('returns 400 for a service name that is not on the allowlist', async () => {
      const { checkAllServices } = await import('@/lib/api/self-hosted/service-health')
      const { req, res } = createMocks({
        method: 'GET',
        query: { ref: 'default', services: 'auth,postgrest' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData()).error.message).toContain('postgrest')
      expect(vi.mocked(checkAllServices)).not.toHaveBeenCalled()
    })
  })
})
