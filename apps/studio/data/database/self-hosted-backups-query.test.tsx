import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useSelfHostedBackupsQuery } from './self-hosted-backups-query'
import type { SelfHostedBackupsResponse } from '@/lib/api/self-hosted/backups/backups.types'
import { customRenderHook } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'

const { mockIsPlatform } = vi.hoisted(() => ({ mockIsPlatform: { value: false } }))

// The hook gates its fetch on the build-time `IS_PLATFORM` constant — mock it so
// both the self-hosted and the platform case can be exercised.
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/constants')
  return {
    ...actual,
    get IS_PLATFORM() {
      return mockIsPlatform.value
    },
  }
})

// The endpoint isn't part of the platform OpenAPI spec, so it's registered
// directly on the MSW server rather than through `addAPIMock`.
const BACKUPS_PATH = '*/api/platform/projects/default/self-hosted/backups'

const BACKUP: SelfHostedBackupsResponse['backups'][number] = {
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
}

const BACKUPS_RESPONSE: SelfHostedBackupsResponse = {
  backups: [BACKUP],
  latest: BACKUP,
  isStale: false,
  expectedIntervalHours: 6,
  isTruncated: false,
  storage: {
    latestModifiedAt: '2026-09-03T00:10:00.000Z',
    objectCount: 12,
    totalBytes: 4096,
    isTruncated: false,
  },
  generatedAt: '2026-09-03T01:00:00.000Z',
}

describe('useSelfHostedBackupsQuery', () => {
  beforeEach(() => {
    mockIsPlatform.value = false
  })

  test('returns the parsed backups payload', async () => {
    mswServer.use(
      http.get(BACKUPS_PATH, () => HttpResponse.json<SelfHostedBackupsResponse>(BACKUPS_RESPONSE))
    )

    const { result } = customRenderHook(() => useSelfHostedBackupsQuery({ projectRef: 'default' }))

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toStrictEqual(BACKUPS_RESPONSE)
  })

  test('surfaces the API error message when the request fails', async () => {
    mswServer.use(
      http.get(BACKUPS_PATH, () =>
        HttpResponse.json(
          { data: null, error: { message: 'Backups are not configured' } },
          { status: 404 }
        )
      )
    )

    const { result } = customRenderHook(() => useSelfHostedBackupsQuery({ projectRef: 'default' }))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Backups are not configured')
  })

  test('falls back to a generic message when the error body has no message', async () => {
    mswServer.use(http.get(BACKUPS_PATH, () => HttpResponse.json({ error: {} }, { status: 502 })))

    const { result } = customRenderHook(() => useSelfHostedBackupsQuery({ projectRef: 'default' }))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Failed to retrieve backups')
  })

  test('errors when the payload does not match the schema', async () => {
    mswServer.use(http.get(BACKUPS_PATH, () => HttpResponse.json({ backups: [{ id: 'nope' }] })))

    const { result } = customRenderHook(() => useSelfHostedBackupsQuery({ projectRef: 'default' }))

    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  test('does not fetch without a project ref', async () => {
    let requestCount = 0
    mswServer.use(
      http.get(BACKUPS_PATH, () => {
        requestCount += 1
        return HttpResponse.json<SelfHostedBackupsResponse>(BACKUPS_RESPONSE)
      })
    )

    const { result } = customRenderHook(() => useSelfHostedBackupsQuery({ projectRef: undefined }))

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(requestCount).toBe(0)
  })

  test('does not fetch on platform builds', async () => {
    mockIsPlatform.value = true

    let requestCount = 0
    mswServer.use(
      http.get(BACKUPS_PATH, () => {
        requestCount += 1
        return HttpResponse.json<SelfHostedBackupsResponse>(BACKUPS_RESPONSE)
      })
    )

    const { result } = customRenderHook(() => useSelfHostedBackupsQuery({ projectRef: 'default' }))

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(requestCount).toBe(0)
  })
})
