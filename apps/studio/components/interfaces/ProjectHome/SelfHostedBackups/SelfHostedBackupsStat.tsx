import { useParams } from 'common'
import dayjs from 'dayjs'
import { Archive, Loader2 } from 'lucide-react'
import { cn, HoverCard, HoverCardContent, HoverCardTrigger } from 'ui'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { getBackupDetailRows } from './SelfHostedBackupsStat.utils'
import { getStaleDescription } from '@/components/interfaces/Database/Backups/SelfHosted/SelfHostedBackups.utils'
import { AlertError } from '@/components/ui/AlertError'
import { SingleStat } from '@/components/ui/SingleStat'
import { useSelfHostedBackupsQuery } from '@/data/database/self-hosted-backups-query'

const DETAIL_ROW_CLASS =
  'px-3 py-2 text-xs flex items-start justify-between gap-x-2 border-b last:border-none'

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className={DETAIL_ROW_CLASS}>
    <span className="text-foreground-light">{label}</span>
    <span className="shrink-0">{value}</span>
  </div>
)

/**
 * Time of the newest completed backup for a self-hosted stack, sitting next to
 * the service status on the project home. The hover card breaks the generation
 * down and calls out a listing that has gone stale.
 */
export const SelfHostedBackupsStat = () => {
  const { ref } = useParams()
  const { data, error, isLoading, isError } = useSelfHostedBackupsQuery({ projectRef: ref })

  if (isLoading) {
    return (
      <SingleStat
        icon={<Loader2 className="animate-spin" size={18} />}
        label={<span>Last backup</span>}
        value={<span>Checking...</span>}
      />
    )
  }

  if (isError) {
    return (
      <AlertError
        error={error}
        subject="Failed to retrieve backups"
        description="Check that the Studio container can reach your backup bucket."
        hideContactSupport
      />
    )
  }

  // The query is disabled without a project ref, which leaves it pending forever.
  if (!data) return null

  const { isStale, latest } = data
  const rows = getBackupDetailRows(data)

  const stat = (
    <SingleStat
      href={`/project/${ref}/database/backups`}
      icon={<Archive size={18} strokeWidth={1.5} className="text-foreground-light" />}
      label={<span>Last backup</span>}
      value={
        latest ? (
          <TimestampInfo
            className={cn('text-base', isStale && 'text-warning')}
            displayAs="utc"
            label={dayjs(latest.createdAt).fromNow()}
            utcTimestamp={latest.createdAt}
          />
        ) : (
          <p className="text-foreground-lighter">No backups</p>
        )
      }
    />
  )

  if (rows.length === 0 && !isStale) return stat

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger tabIndex={0}>{stat}</HoverCardTrigger>
      <HoverCardContent className="p-0 w-72" side="bottom" align="start">
        {isStale && (
          <p className={cn(DETAIL_ROW_CLASS, 'text-warning')}>
            {getStaleDescription(data.expectedIntervalHours)}
          </p>
        )}
        {rows.map((row) => (
          <DetailRow key={row.label} label={row.label} value={row.value} />
        ))}
      </HoverCardContent>
    </HoverCard>
  )
}
