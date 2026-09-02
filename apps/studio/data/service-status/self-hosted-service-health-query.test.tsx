import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useSelfHostedServiceHealthQuery } from './self-hosted-service-health-query'
import type { SelfHostedServiceHealthResponse } from '@/lib/api/self-hosted/service-health.types'
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
const HEALTH_PATH = '*/api/platform/projects/default/self-hosted/service-health'

const HEALTH_RESPONSE: SelfHostedServiceHealthResponse = {
  services: [
    {
      name: 'db',
      status: 'ACTIVE_HEALTHY',
      latencyMs: 12,
      checkedAt: '2026-09-02T00:00:00.000Z',
      info: { version: 'PostgreSQL 17.0' },
    },
    {
      name: 'pooler',
      status: 'DISABLED',
      latencyMs: null,
      checkedAt: '2026-09-02T00:00:00.000Z',
    },
    {
      name: 'storage',
      status: 'UNHEALTHY',
      latencyMs: null,
      checkedAt: '2026-09-02T00:00:00.000Z',
      error: 'Connection refused',
    },
  ],
}

describe('useSelfHostedServiceHealthQuery', () => {
  beforeEach(() => {
    mockIsPlatform.value = false
  })

  test('returns the parsed service health payload', async () => {
    mswServer.use(
      http.get(HEALTH_PATH, () =>
        HttpResponse.json<SelfHostedServiceHealthResponse>(HEALTH_RESPONSE)
      )
    )

    const { result } = customRenderHook(() =>
      useSelfHostedServiceHealthQuery({ projectRef: 'default' })
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toStrictEqual(HEALTH_RESPONSE)
  })

  test('surfaces the API error message when the request fails', async () => {
    mswServer.use(
      http.get(HEALTH_PATH, () =>
        HttpResponse.json(
          { data: null, error: { message: 'Service health check failed' } },
          { status: 500 }
        )
      )
    )

    const { result } = customRenderHook(() =>
      useSelfHostedServiceHealthQuery({ projectRef: 'default' })
    )

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Service health check failed')
  })

  test('falls back to a generic message when the error body has no message', async () => {
    mswServer.use(http.get(HEALTH_PATH, () => HttpResponse.json({ error: {} }, { status: 500 })))

    const { result } = customRenderHook(() =>
      useSelfHostedServiceHealthQuery({ projectRef: 'default' })
    )

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Failed to retrieve service health')
  })

  test('errors when the payload does not match the schema', async () => {
    mswServer.use(http.get(HEALTH_PATH, () => HttpResponse.json({ services: [{ name: 'db' }] })))

    const { result } = customRenderHook(() =>
      useSelfHostedServiceHealthQuery({ projectRef: 'default' })
    )

    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  test('does not fetch without a project ref', async () => {
    let requestCount = 0
    mswServer.use(
      http.get(HEALTH_PATH, () => {
        requestCount += 1
        return HttpResponse.json<SelfHostedServiceHealthResponse>(HEALTH_RESPONSE)
      })
    )

    const { result } = customRenderHook(() =>
      useSelfHostedServiceHealthQuery({ projectRef: undefined })
    )

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(requestCount).toBe(0)
  })

  test('does not fetch on platform builds', async () => {
    mockIsPlatform.value = true

    let requestCount = 0
    mswServer.use(
      http.get(HEALTH_PATH, () => {
        requestCount += 1
        return HttpResponse.json<SelfHostedServiceHealthResponse>(HEALTH_RESPONSE)
      })
    )

    const { result } = customRenderHook(() =>
      useSelfHostedServiceHealthQuery({ projectRef: 'default' })
    )

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(requestCount).toBe(0)
  })
})
