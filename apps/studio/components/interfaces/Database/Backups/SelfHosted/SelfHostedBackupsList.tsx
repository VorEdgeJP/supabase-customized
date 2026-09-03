import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { useParams } from 'common'
import { useMemo, useState } from 'react'
import {
  Badge,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
} from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { BackupsEmpty } from '../BackupsEmpty'
import { SelfHostedBackupDownloadMenu } from './SelfHostedBackupDownloadMenu'
import { SelfHostedBackupItem } from './SelfHostedBackupItem'
import {
  BACKUP_TIER_FILTERS,
  filterBackupsByTier,
  formatBackupSize,
  formatDatabaseList,
  formatHours,
  formatRelativeTime,
  getBackupStatusLabel,
  getBackupTierFilterLabel,
  getBackupTierLabel,
  getStaleDescription,
  isBackupTierFilter,
  NO_VALUE,
  type SelfHostedBackupTierFilter,
} from './SelfHostedBackups.utils'
import { AlertError } from '@/components/ui/AlertError'
import { useSelfHostedBackupsQuery } from '@/data/database/self-hosted-backups-query'
import type { SelfHostedBackup } from '@/lib/api/self-hosted/backups/backups.types'

const BACKUP_COLUMNS: ColumnDef<SelfHostedBackup>[] = [
  {
    id: 'createdAt',
    header: 'Created at',
    cell: ({ row }) => (
      <TimestampInfo
        displayAs="utc"
        utcTimestamp={row.original.createdAt}
        labelFormat="DD MMM YYYY HH:mm:ss (ZZ)"
        className="text-left text-sm! font-mono tracking-tight"
      />
    ),
  },
  {
    id: 'tier',
    header: 'Tier',
    cell: ({ row }) => <Badge variant="default">{getBackupTierLabel(row.original.tier)}</Badge>,
  },
  {
    id: 'databases',
    header: 'Databases',
    cell: ({ row }) => (
      <p className="text-foreground-light">{formatDatabaseList(row.original.databases)}</p>
    ),
  },
  {
    id: 'size',
    header: 'Size',
    cell: ({ row }) => (
      <p className="text-foreground-light">{formatBackupSize(row.original.totalBytes)}</p>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={row.original.status === 'COMPLETED' ? 'success' : 'warning'}>
        {getBackupStatusLabel(row.original.status)}
      </Badge>
    ),
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => (
      <div className="flex justify-end">
        <SelfHostedBackupDownloadMenu backup={row.original} />
      </div>
    ),
  },
]

const SummaryItem = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-y-1">
    <span className="heading-meta text-foreground-light">{label}</span>
    <span className="text-sm text-foreground">{value}</span>
  </div>
)

/**
 * Backups taken by the host's cron and uploaded to an S3-compatible bucket. The
 * listing is read-only — Studio never takes or restores a backup here, it only
 * hands out short-lived download links for the encrypted files.
 */
export const SelfHostedBackupsList = () => {
  const { ref: projectRef } = useParams()
  const [tierFilter, setTierFilter] = useState<SelfHostedBackupTierFilter>('all')

  const { data, error, isPending, isError, isSuccess } = useSelfHostedBackupsQuery({ projectRef })

  const backups = useMemo(
    () => (data === undefined ? [] : filterBackupsByTier(data.backups, tierFilter)),
    [data, tierFilter]
  )

  const table = useReactTable({
    data: backups,
    columns: BACKUP_COLUMNS,
    getRowId: (backup) => backup.id,
    getCoreRowModel: getCoreRowModel(),
  })

  if (isPending) return <GenericSkeletonLoader />

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

  if (!isSuccess) return null

  const rows = table.getRowModel().rows

  return (
    <div className="flex flex-col gap-y-4">
      <p className="text-sm text-foreground-light">
        Backups are taken on the host and uploaded to your bucket. Downloaded files stay encrypted
        and can only be read with your decryption key.
      </p>

      {data.isStale && (
        <Admonition
          type="warning"
          title="Backups are behind schedule"
          description={getStaleDescription(data.expectedIntervalHours)}
        />
      )}

      {data.isTruncated && (
        <Admonition
          type="default"
          title="Only the most recent backups are listed"
          description="Your bucket holds more objects than this listing walks through, so older generations are not shown."
        />
      )}

      <Card className="flex flex-col gap-y-6 p-6 sm:flex-row sm:gap-x-12 sm:gap-y-0">
        <SummaryItem
          label="Last backup"
          value={data.latest === null ? NO_VALUE : formatRelativeTime(data.latest.createdAt)}
        />
        <SummaryItem label="Expected interval" value={formatHours(data.expectedIntervalHours)} />
        {data.storage !== null && (
          <SummaryItem
            label="Storage sync"
            value={formatRelativeTime(data.storage.latestModifiedAt)}
          />
        )}
      </Card>

      {data.backups.length === 0 && <BackupsEmpty />}

      {data.backups.length > 0 && (
        <>
          <ToggleGroup
            type="single"
            size="tiny"
            value={tierFilter}
            onValueChange={(value) => {
              if (isBackupTierFilter(value)) setTierFilter(value)
            }}
            className="justify-start"
          >
            {BACKUP_TIER_FILTERS.map((filter) => (
              <ToggleGroupItem key={filter} value={filter}>
                {getBackupTierFilterLabel(filter)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Card>
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow className="[&>td]:hover:bg-inherit">
                    <TableCell colSpan={BACKUP_COLUMNS.length}>
                      <p className="text-sm text-foreground">No backups found</p>
                      <p className="text-sm text-foreground-lighter">
                        {tierFilter === 'all'
                          ? 'Your bucket holds no backups yet'
                          : `Your bucket holds no ${getBackupTierLabel(tierFilter).toLowerCase()} backups yet`}
                      </p>
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <SelfHostedBackupItem key={row.id} row={row} />
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}
