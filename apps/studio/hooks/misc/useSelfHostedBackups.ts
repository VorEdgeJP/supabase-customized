import { useMemo } from 'react'

import { useDeploymentModeQuery } from '@/data/config/deployment-mode-query'
import { IS_PLATFORM } from '@/lib/constants'

export type SelfHostedBackups = {
  /** Whether the self-hosted stack has a backup bucket configured. */
  isBackupsEnabled: boolean
}

/**
 * Resolves whether the self-hosted backup surfaces have a bucket behind them.
 *
 * The flag is false on platform builds — platform gates its own backup pages on
 * `IS_PLATFORM` instead — and false during the loading window, so a surface is
 * only mounted once the server has confirmed it can answer. The underlying
 * query is disabled on platform builds, so the hook is a no-op there.
 *
 * The return is memoized on the primitive flag so consumers can safely list the
 * whole object in their `useMemo`/`useCallback` deps.
 */
export function useSelfHostedBackups(): SelfHostedBackups {
  const { data } = useDeploymentModeQuery()

  const isBackupsEnabled = !IS_PLATFORM && (data?.backups_enabled ?? false)

  return useMemo(() => ({ isBackupsEnabled }), [isBackupsEnabled])
}
