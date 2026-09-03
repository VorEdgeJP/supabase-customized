import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../pages/api/platform/deployment-mode'
import {
  isSelfHostedBackupsEnabled,
  isSelfHostedMetricsEnabled,
  type MetricsRequestsSource,
} from '@/lib/api/self-hosted/constants'

const { config } = vi.hoisted(() => ({
  config: { requestsSource: 'disabled' as MetricsRequestsSource },
}))

vi.mock('@/lib/api/self-hosted/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-hosted/constants')>()),
  isSelfHostedMetricsEnabled: vi.fn(),
  isSelfHostedBackupsEnabled: vi.fn(),
  get METRICS_REQUESTS_SOURCE() {
    return config.requestsSource
  },
}))

describe('/api/platform/deployment-mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.requestsSource = 'disabled'
    vi.mocked(isSelfHostedMetricsEnabled).mockReturnValue(false)
    vi.mocked(isSelfHostedBackupsEnabled).mockReturnValue(false)
  })

  it('returns 405 for non-GET methods', async () => {
    const { req, res } = createMocks({ method: 'POST' })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(405)
    expect(res.getHeader('Allow')).toEqual(['GET'])
  })

  it('reports metrics and backups as disabled when nothing is configured', async () => {
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(200)
    expect(JSON.parse(res._getData())).toEqual({
      is_cli_mode: false,
      metrics_enabled: false,
      usage_api_counts_source: 'disabled',
      backups_enabled: false,
    })
  })

  it('reports backups as enabled when a bucket is configured', async () => {
    vi.mocked(isSelfHostedBackupsEnabled).mockReturnValue(true)
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    expect(JSON.parse(res._getData())).toMatchObject({ backups_enabled: true })
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
