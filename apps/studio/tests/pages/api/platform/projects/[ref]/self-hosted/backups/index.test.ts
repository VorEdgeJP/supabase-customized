import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../../../../../pages/api/platform/projects/[ref]/self-hosted/backups/index'
import {
  selfHostedBackupsResponseSchema,
  type SelfHostedBackupsResponse,
} from '@/lib/api/self-hosted/backups/backups.types'
import { S3Error } from '@/lib/api/self-hosted/backups/s3'

vi.mock('@/lib/api/self-hosted/backups/backups', () => ({
  listBackups: vi.fn(),
}))

vi.mock('@/lib/api/self-hosted/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api/self-hosted/constants')
  return { ...actual, isSelfHostedBackupsEnabled: vi.fn() }
})

const response: SelfHostedBackupsResponse = {
  backups: [
    {
      id: '6h/20260903T000000Z',
      tier: '6h',
      createdAt: '2026-09-03T00:00:00.000Z',
      uploadedAt: '2026-09-03T00:04:00.000Z',
      status: 'COMPLETED',
      databases: ['postgres'],
      totalBytes: 2048,
      files: [
        {
          name: 'postgres.dump.age',
          key: 'db/6h/2026/09/03/20260903T000000Z/postgres.dump.age',
          size: 2048,
          lastModified: '2026-09-03T00:04:00.000Z',
        },
      ],
    },
  ],
  latest: null,
  isStale: false,
  expectedIntervalHours: 6,
  isTruncated: false,
  storage: null,
  generatedAt: '2026-09-03T06:00:00.000Z',
}

describe('/api/platform/projects/[ref]/self-hosted/backups', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    const { isSelfHostedBackupsEnabled } = await import('@/lib/api/self-hosted/constants')
    vi.mocked(isSelfHostedBackupsEnabled).mockReturnValue(true)

    const { listBackups } = await import('@/lib/api/self-hosted/backups/backups')
    vi.mocked(listBackups).mockResolvedValue(response)
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
      const parsed = selfHostedBackupsResponseSchema.safeParse(JSON.parse(res._getData()))
      expect(parsed.success).toBe(true)
      expect(parsed.data?.backups).toHaveLength(1)
    })

    it('returns 404 when no backup bucket is configured', async () => {
      const { isSelfHostedBackupsEnabled } = await import('@/lib/api/self-hosted/constants')
      vi.mocked(isSelfHostedBackupsEnabled).mockReturnValue(false)
      const { listBackups } = await import('@/lib/api/self-hosted/backups/backups')

      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(404)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Backups are not configured' },
      })
      expect(vi.mocked(listBackups)).not.toHaveBeenCalled()
    })

    it('returns 502 with the normalized message when the bucket request fails', async () => {
      const { listBackups } = await import('@/lib/api/self-hosted/backups/backups')
      vi.mocked(listBackups).mockRejectedValue(new S3Error('HTTP 403', 403))

      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'HTTP 403' },
      })
    })

    it('returns 400 when the listing does not match the shared schema', async () => {
      const { listBackups } = await import('@/lib/api/self-hosted/backups/backups')
      const invalid = selfHostedBackupsResponseSchema.safeParse({})
      vi.mocked(listBackups).mockRejectedValue(invalid.error)

      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'The backup listing could not be read' },
      })
    })

    it('returns 500 without detail for an unexpected failure', async () => {
      const { listBackups } = await import('@/lib/api/self-hosted/backups/backups')
      vi.mocked(listBackups).mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:443'))

      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(500)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Failed to list backups' },
      })
    })
  })
})
