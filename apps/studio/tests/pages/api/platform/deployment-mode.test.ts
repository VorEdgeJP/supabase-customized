import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../pages/api/platform/deployment-mode'
import {
  isSelfHostedMetricsEnabled,
  type MetricsRequestsSource,
} from '@/lib/api/self-hosted/constants'

const { config } = vi.hoisted(() => ({
  config: { requestsSource: 'disabled' as MetricsRequestsSource },
}))

vi.mock('@/lib/api/self-hosted/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-hosted/constants')>()),
  isSelfHostedMetricsEnabled: vi.fn(),
  get METRICS_REQUESTS_SOURCE() {
    return config.requestsSource
  },
}))

describe('/api/platform/deployment-mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.requestsSource = 'disabled'
    vi.mocked(isSelfHostedMetricsEnabled).mockReturnValue(false)
  })

  it('returns 405 for non-GET methods', async () => {
    const { req, res } = createMocks({ method: 'POST' })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(405)
    expect(res.getHeader('Allow')).toEqual(['GET'])
  })

  it('reports metrics as disabled when Prometheus is not configured', async () => {
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(200)
    expect(JSON.parse(res._getData())).toEqual({
      is_cli_mode: false,
      metrics_enabled: false,
      usage_api_counts_source: 'disabled',
    })
  })

  it('reports the resolved metrics configuration', async () => {
    vi.mocked(isSelfHostedMetricsEnabled).mockReturnValue(true)
    config.requestsSource = 'prometheus'
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    expect(JSON.parse(res._getData())).toMatchObject({
      metrics_enabled: true,
      usage_api_counts_source: 'prometheus',
    })
  })

  it('reports Logflare as the requests source when only Logflare is configured', async () => {
    config.requestsSource = 'logflare'
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    expect(JSON.parse(res._getData())).toMatchObject({
      metrics_enabled: false,
      usage_api_counts_source: 'logflare',
    })
  })
})
