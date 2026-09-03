import { useMemo } from 'react'

import { useDeploymentModeQuery } from '@/data/config/deployment-mode-query'
import { IS_PLATFORM } from '@/lib/constants'

export type SelfHostedMetrics = {
  /** Whether the self-hosted stack can serve compute metrics (Prometheus is configured). */
  isMetricsEnabled: boolean
  /** Whether the home Requests chart has a data source (Prometheus or Logflare). */
  isUsageChartEnabled: boolean
}

/**
 * Resolves which self-hosted metrics surfaces have a data source behind them.
 *
 * Both flags are false on platform builds — platform gates those surfaces on
 * `IS_PLATFORM` instead — and false during the loading window, so a surface is
 * only mounted once the server has confirmed it can answer. The underlying
 * query is disabled on platform builds, so the hook is a no-op there.
 *
 * The return is memoized on the primitive flags so consumers can safely list
 * the whole object in their `useMemo`/`useCallback` deps.
 */
export function useSelfHostedMetrics(): SelfHostedMetrics {
  const { data } = useDeploymentModeQuery()

  const isMetricsEnabled = !IS_PLATFORM && (data?.metrics_enabled ?? false)
  const isUsageChartEnabled =
    !IS_PLATFORM && (data?.usage_api_counts_source ?? 'disabled') !== 'disabled'

  return useMemo(
    () => ({ isMetricsEnabled, isUsageChartEnabled }),
    [isMetricsEnabled, isUsageChartEnabled]
  )
}
