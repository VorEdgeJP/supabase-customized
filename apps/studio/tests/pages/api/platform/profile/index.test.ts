import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '../../../../../pages/api/platform/profile/index'

const { config } = vi.hoisted(() => ({
  config: { disabledFeatures: [] as string[] },
}))

vi.mock('@/lib/api/self-hosted/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-hosted/constants')>()),
  get STUDIO_DISABLED_FEATURES() {
    return config.disabledFeatures
  },
}))

describe('/api/platform/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    config.disabledFeatures = []
  })

  it('returns 405 for non-GET methods', async () => {
    const { req, res } = createMocks({ method: 'POST' })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(405)
    expect(res.getHeader('Allow')).toEqual(['GET'])
  })

  it('reports no disabled features by default', async () => {
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    expect(res._getStatusCode()).toBe(200)
    expect(JSON.parse(res._getData())).toMatchObject({ disabled_features: [] })
  })

  it('reports the product areas the deployment hides', async () => {
    config.disabledFeatures = ['project_auth:all', 'project_edge_function:all', 'realtime:all']
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    expect(JSON.parse(res._getData()).disabled_features).toEqual([
      'project_auth:all',
      'project_edge_function:all',
      'realtime:all',
    ])
  })

  it('still returns the default organization and project', async () => {
    const { req, res } = createMocks({ method: 'GET' })

    await handler(req, res)

    const body = JSON.parse(res._getData())
    expect(body.organizations).toHaveLength(1)
    expect(body.organizations[0].projects).toHaveLength(1)
  })
})
