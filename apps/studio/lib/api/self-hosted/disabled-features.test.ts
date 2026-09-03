import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `STUDIO_DISABLED_FEATURES` is read at module scope, so each case re-imports
 * the module with a fresh env.
 */
async function loadDisabledFeatures(value: string | undefined): Promise<string[]> {
  vi.resetModules()
  if (value === undefined) {
    delete process.env.STUDIO_DISABLED_FEATURES
  } else {
    process.env.STUDIO_DISABLED_FEATURES = value
  }
  const { STUDIO_DISABLED_FEATURES } = await import('./constants')
  return STUDIO_DISABLED_FEATURES
}

describe('api/self-hosted/constants STUDIO_DISABLED_FEATURES', () => {
  const originalValue = process.env.STUDIO_DISABLED_FEATURES

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.STUDIO_DISABLED_FEATURES
    } else {
      process.env.STUDIO_DISABLED_FEATURES = originalValue
    }
    vi.resetModules()
  })

  it('is empty when the variable is unset', async () => {
    expect(await loadDisabledFeatures(undefined)).toEqual([])
  })

  it('is empty for a blank value', async () => {
    expect(await loadDisabledFeatures('   ')).toEqual([])
  })

  it('splits a comma-separated list and trims each entry', async () => {
    expect(await loadDisabledFeatures('project_auth:all, realtime:all')).toEqual([
      'project_auth:all',
      'realtime:all',
    ])
  })

  it('drops empty entries from a trailing or doubled comma', async () => {
    expect(await loadDisabledFeatures('project_auth:all,,realtime:all,')).toEqual([
      'project_auth:all',
      'realtime:all',
    ])
  })
})
