import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../../../../../pages/api/platform/projects/[ref]/self-hosted/backups/download'
import { selfHostedBackupDownloadResponseSchema } from '@/lib/api/self-hosted/backups/backups.types'
import { S3Error } from '@/lib/api/self-hosted/backups/s3'

vi.mock('@/lib/api/self-hosted/backups/backups', () => ({
  isAllowedDownloadKey: vi.fn(),
}))

vi.mock('@/lib/api/self-hosted/backups/s3', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api/self-hosted/backups/s3')
  return { ...actual, presignGetObject: vi.fn() }
})

vi.mock('@/lib/api/self-hosted/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api/self-hosted/constants')
  return { ...actual, isSelfHostedBackupsEnabled: vi.fn() }
})

const KEY = 'db/6h/2026/09/03/20260903T000000Z/postgres.dump.age'
const FILE_URL = 'https://bucket.example.com/db/6h/postgres.dump.age?X-Amz-Signature=abc'

describe('/api/platform/projects/[ref]/self-hosted/backups/download', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    const { isSelfHostedBackupsEnabled } = await import('@/lib/api/self-hosted/constants')
    vi.mocked(isSelfHostedBackupsEnabled).mockReturnValue(true)

    const { isAllowedDownloadKey } = await import('@/lib/api/self-hosted/backups/backups')
    vi.mocked(isAllowedDownloadKey).mockReturnValue(true)

    const { presignGetObject } = await import('@/lib/api/self-hosted/backups/s3')
    vi.mocked(presignGetObject).mockReturnValue(FILE_URL)
  })

  describe('Method handling', () => {
    it('should return 405 for non-POST methods', async () => {
      const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(405)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Method GET Not Allowed' },
      })
      expect(res.getHeader('Allow')).toEqual(['POST'])
    })
  })

  describe('POST', () => {
    it('returns a presigned URL for a key from the listing', async () => {
      const { presignGetObject } = await import('@/lib/api/self-hosted/backups/s3')
      const { req, res } = createMocks({
        method: 'POST',
        query: { ref: 'default' },
        body: { key: KEY },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      const parsed = selfHostedBackupDownloadResponseSchema.safeParse(JSON.parse(res._getData()))
      expect(parsed.success).toBe(true)
      expect(parsed.data?.fileUrl).toBe(FILE_URL)
      expect(vi.mocked(presignGetObject)).toHaveBeenCalledWith(
        expect.objectContaining({
          key: KEY,
          responseContentDisposition: `attachment; filename="${KEY.split('/').pop()}"`,
        })
      )
    })

    it('returns 404 when no backup bucket is configured', async () => {
      const { isSelfHostedBackupsEnabled } = await import('@/lib/api/self-hosted/constants')
      vi.mocked(isSelfHostedBackupsEnabled).mockReturnValue(false)
      const { presignGetObject } = await import('@/lib/api/self-hosted/backups/s3')

      const { req, res } = createMocks({
        method: 'POST',
        query: { ref: 'default' },
        body: { key: KEY },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(404)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Backups are not configured' },
      })
      expect(vi.mocked(presignGetObject)).not.toHaveBeenCalled()
    })

    it('returns 400 when the body has no key', async () => {
      const { presignGetObject } = await import('@/lib/api/self-hosted/backups/s3')
      const { req, res } = createMocks({ method: 'POST', query: { ref: 'default' }, body: {} })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'A backup key is required' },
      })
      expect(vi.mocked(presignGetObject)).not.toHaveBeenCalled()
    })

    it('returns 400 for a key that is not part of the listing', async () => {
      const { isAllowedDownloadKey } = await import('@/lib/api/self-hosted/backups/backups')
      vi.mocked(isAllowedDownloadKey).mockReturnValue(false)
      const { presignGetObject } = await import('@/lib/api/self-hosted/backups/s3')

      const { req, res } = createMocks({
        method: 'POST',
        query: { ref: 'default' },
        body: { key: 'db/../secrets/token' },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(400)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Invalid backup key' },
      })
      expect(vi.mocked(presignGetObject)).not.toHaveBeenCalled()
    })

    it('returns 502 with the normalized message when signing fails', async () => {
      const { presignGetObject } = await import('@/lib/api/self-hosted/backups/s3')
      vi.mocked(presignGetObject).mockImplementation(() => {
        throw new S3Error('Backups are not configured')
      })

      const { req, res } = createMocks({
        method: 'POST',
        query: { ref: 'default' },
        body: { key: KEY },
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(502)
      expect(JSON.parse(res._getData())).toEqual({
        data: null,
        error: { message: 'Backups are not configured' },
      })
    })
  })
})
