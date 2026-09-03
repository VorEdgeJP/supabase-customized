import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useSelfHostedBackups } from '../useSelfHostedBackups'

const { mockIsPlatform, mockUseDeploymentModeQuery } = vi.hoisted(() => ({
  mockIsPlatform: { value: false },
  mockUseDeploymentModeQuery: vi.fn(),
}))

vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/constants')
  return {
    ...actual,
    get IS_PLATFORM() {
      return mockIsPlatform.value
    },
  }
})

vi.mock('@/data/config/deployment-mode-query', () => ({
  useDeploymentModeQuery: mockUseDeploymentModeQuery,
}))

describe('useSelfHostedBackups', () => {
  beforeEach(() => {
    mockIsPlatform.value = false
    mockUseDeploymentModeQuery.mockReset()
  })

  test('platform build: disabled regardless of query state', () => {
    mockIsPlatform.value = true
    mockUseDeploymentModeQuery.mockReturnValue({ data: { backups_enabled: true } })

    const { result } = renderHook(() => useSelfHostedBackups())

    expect(result.current).toEqual({ isBackupsEnabled: false })
  })

  test('non-platform, loading window (data undefined): disabled', () => {
    // The surface only mounts once the server confirms a bucket is configured,
    // so the loading window has to read as disabled rather than as enabled.
    mockUseDeploymentModeQuery.mockReturnValue({ data: undefined })

    const { result } = renderHook(() => useSelfHostedBackups())

    expect(result.current).toEqual({ isBackupsEnabled: false })
  })

  test('non-platform, resolved backups_enabled=false: disabled', () => {
    mockUseDeploymentModeQuery.mockReturnValue({ data: { backups_enabled: false } })

    const { result } = renderHook(() => useSelfHostedBackups())

    expect(result.current).toEqual({ isBackupsEnabled: false })
  })

  test('non-platform, resolved backups_enabled=true: enabled', () => {
    mockUseDeploymentModeQuery.mockReturnValue({ data: { backups_enabled: true } })

    const { result } = renderHook(() => useSelfHostedBackups())

    expect(result.current).toEqual({ isBackupsEnabled: true })
  })

  test('returns a stable reference across renders when the flag does not change', () => {
    // Distinct `data` object refs with equal contents — pins memoization on the
    // primitive flag, not on the `data` reference.
    mockUseDeploymentModeQuery
      .mockReturnValueOnce({ data: { backups_enabled: true } })
      .mockReturnValueOnce({ data: { backups_enabled: true } })

    const { result, rerender } = renderHook(() => useSelfHostedBackups())
    const first = result.current
    rerender()

    expect(result.current).toBe(first)
  })
})
