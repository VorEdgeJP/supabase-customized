import {
  formatBackupSize,
  formatDatabaseList,
  formatFileCount,
  formatRelativeTime,
  getBackupStatusLabel,
  getBackupTierLabel,
} from '@/components/interfaces/Database/Backups/SelfHosted/SelfHostedBackups.utils'
import type { SelfHostedBackupsResponse } from '@/lib/api/self-hosted/backups/backups.types'

export type SelfHostedBackupDetailRow = {
  label: string
  value: string
}

/**
 * Rows shown in the hover card behind the "Last backup" stat: what the newest
 * completed generation holds, followed by the storage sync when the deployment
 * has a storage prefix configured.
 */
export function getBackupDetailRows(data: SelfHostedBackupsResponse): SelfHostedBackupDetailRow[] {
  const rows: SelfHostedBackupDetailRow[] = []

  if (data.latest !== null) {
    rows.push(
      { label: 'Tier', value: getBackupTierLabel(data.latest.tier) },
      { label: 'Databases', value: formatDatabaseList(data.latest.databases) },
      { label: 'Size', value: formatBackupSize(data.latest.totalBytes) },
      { label: 'Files', value: formatFileCount(data.latest.files.length) },
      { label: 'Status', value: getBackupStatusLabel(data.latest.status) }
    )
  }

  if (data.storage !== null) {
    rows.push({
      label: 'Storage sync',
      value: formatRelativeTime(data.storage.latestModifiedAt),
    })
  }

  return rows
}
