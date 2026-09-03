import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useSelfHostedMetrics } from '../useSelfHostedMetrics'

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

describe('useSelfHostedMetrics', () => {
  beforeEach(() => {
    mockIsPlatform.value = false
    mockUseDeploymentModeQuery.mockReset()
  })

  test('platform build: both flags are false regardless of query state', () => {
    mockIsPlatform.value = true
    mockUseDeploymentModeQuery.mockReturnValue({
      data: { metrics_enabled: true, usage_api_counts_source: 'prometheus' },
    })

    const { result } = renderHook(() => useSelfHostedMetrics())

    expect(result.current).toEqual({ isMetricsEnabled: false, isUsageChartEnabled: false })
  })

  test('loading window (data undefined): both flags are false', () => {
    mockUseDeploymentModeQuery.mockReturnValue({ data: undefined })

    const { result } = renderHook(() => useSelfHostedMetrics())

    expect(result.current).toEqual({ isMetricsEnabled: false, isUsageChartEnabled: false })
  })

  test('metrics disabled and no usage source: both flags are false', () => {
    mockUseDeploymentModeQuery.mockReturnValue({
      data: { is_cli_mode: false, metrics_enabled: false, usage_api_counts_source: 'disabled' },
    })

    const { result } = renderHook(() => useSelfHostedMetrics())

    expect(result.current).toEqual({ isMetricsEnabled: false, isUsageChartEnabled: false })
  })

  test('metrics enabled with a Prometheus usage source: both flags are true', () => {
    mockUseDeploymentModeQuery.mockReturnValue({
      data: { is_cli_mode: false, metrics_enabled: true, usage_api_counts_source: 'prometheus' },
    })

    const { result } = renderHook(() => useSelfHostedMetrics())

    expect(result.current).toEqual({ isMetricsEnabled: true, isUsageChartEnabled: true })
  })

  test('Logflare usage source without Prometheus: only the usage chart is enabled', () => {
    mockUseDeploymentModeQuery.mockReturnValue({
      data: { is_cli_mode: false, metrics_enabled: false, usage_api_counts_source: 'logflare' },
    })

    const { result } = renderHook(() => useSelfHostedMetrics())

    expect(result.current).toEqual({ isMetricsEnabled: false, isUsageChartEnabled: true })
  })

  test('Prometheus without a usage source: only compute metrics are enabled', () => {
    mockUseDeploymentModeQuery.mockReturnValue({
      data: { is_cli_mode: false, metrics_enabled: true, usage_api_counts_source: 'disabled' },
    })

    const { result } = renderHook(() => useSelfHostedMetrics())

    expect(result.current).toEqual({ isMetricsEnabled: true, isUsageChartEnabled: false })
  })

  test('missing fields on an older server response: both flags are false', () => {
    mockUseDeploymentModeQuery.mockReturnValue({ data: { is_cli_mode: false } })

    const { result } = renderHook(() => useSelfHostedMetrics())

    expect(result.current).toEqual({ isMetricsEnabled: false, isUsageChartEnabled: false })
  })

  test('returns a stable reference across renders when the flags do not change', () => {
    // Distinct `data` object refs with equal contents — pins memoization on the
    // primitive flags, not on the `data` reference.
    mockUseDeploymentModeQuery
      .mockReturnValueOnce({
        data: { metrics_enabled: true, usage_api_counts_source: 'prometheus' },
      })
      .mockReturnValueOnce({
        data: { metrics_enabled: true, usage_api_counts_source: 'prometheus' },
      })

    const { result, rerender } = renderHook(() => useSelfHostedMetrics())
    const first = result.current
    rerender()

    expect(result.current).toBe(first)
  })
})
