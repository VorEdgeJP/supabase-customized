import { useParams } from 'common'
import { Cpu, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from 'ui'

import {
  COMPUTE_REFRESH_INTERVAL_MS,
  formatByteRatio,
  formatCountRatio,
  formatPercent,
  getComputeMetricsRange,
  getLatestValues,
  getUsagePercent,
  SELF_HOSTED_COMPUTE_ATTRIBUTES,
} from './SelfHostedComputeStat.utils'
import { AlertError } from '@/components/ui/AlertError'
import { SingleStat } from '@/components/ui/SingleStat'
import { useInfraMonitoringAttributesQuery } from '@/data/analytics/infra-monitoring-query'
import { useSelfHostedMetrics } from '@/hooks/misc/useSelfHostedMetrics'

const DETAIL_ROW_CLASS =
  'px-3 py-2 text-xs flex items-start justify-between gap-x-2 border-b last:border-none'

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className={DETAIL_ROW_CLASS}>
    <span className="text-foreground-light">{label}</span>
    <span className="shrink-0">{value}</span>
  </div>
)

/**
 * Compute usage for a self-hosted stack, sitting next to the service status on
 * the project home. Reads the last few minutes of metrics and shows the most
 * recent sample; the hover card breaks the summary down.
 */
export const SelfHostedComputeStat = () => {
  const { ref } = useParams()
  const { isMetricsEnabled } = useSelfHostedMetrics()

  // Re-anchors the requested range on a fixed tick. `getComputeMetricsRange`
  // aligns both ends to the minute, so the query key only changes once a
  // minute while the poll below keeps the data fresh in between.
  const [rangeAnchor, setRangeAnchor] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setRangeAnchor(Date.now()), COMPUTE_REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  const { startDate, endDate } = useMemo(
    () => getComputeMetricsRange(new Date(rangeAnchor)),
    [rangeAnchor]
  )

  const { data, error, isLoading, isError } = useInfraMonitoringAttributesQuery(
    {
      projectRef: ref,
      attributes: [...SELF_HOSTED_COMPUTE_ATTRIBUTES],
      startDate,
      endDate,
      interval: '1m',
    },
    { enabled: isMetricsEnabled, refetchInterval: COMPUTE_REFRESH_INTERVAL_MS }
  )

  if (isLoading) {
    return (
      <SingleStat
        icon={<Loader2 className="animate-spin" size={18} />}
        label={<span>Compute</span>}
        value={<span>Checking...</span>}
      />
    )
  }

  if (isError) {
    return (
      <AlertError
        error={error as { message: string } | null}
        subject="Failed to retrieve compute metrics"
        description="Check that the Studio container can reach Prometheus on your Docker network."
        hideContactSupport
      />
    )
  }

  // The query is disabled without a project ref, which leaves it pending forever.
  if (!data) return null

  const values = getLatestValues(data)
  const cpuPercent = formatPercent(values.avg_cpu_usage)
  const memoryPercent = formatPercent(
    values.ram_usage ?? getUsagePercent(values.ram_usage_used, values.ram_usage_total)
  )
  const diskPercent = formatPercent(getUsagePercent(values.disk_fs_used, values.disk_fs_size))

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger tabIndex={0}>
        <SingleStat
          icon={<Cpu size={18} strokeWidth={1.5} className="text-foreground-light" />}
          label={<span>Compute</span>}
          value={
            <span className="text-sm">
              CPU {cpuPercent} · Memory {memoryPercent} · Disk {diskPercent}
            </span>
          }
        />
      </HoverCardTrigger>
      <HoverCardContent className="p-0 w-72" side="bottom" align="start">
        <DetailRow label="CPU" value={cpuPercent} />
        <DetailRow
          label="Memory"
          value={formatByteRatio(values.ram_usage_used, values.ram_usage_total)}
        />
        <DetailRow label="Disk" value={formatByteRatio(values.disk_fs_used, values.disk_fs_size)} />
        <DetailRow
          label="Connections"
          value={formatCountRatio(values.pg_stat_database_num_backends, values.max_db_connections)}
        />
      </HoverCardContent>
    </HoverCard>
  )
}
