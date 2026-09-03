import dayjs from 'dayjs'

import {
  SELF_HOSTED_BACKUP_TIERS,
  type SelfHostedBackup,
  type SelfHostedBackupStatus,
  type SelfHostedBackupTier,
} from '@/lib/api/self-hosted/backups/backups.types'
import { formatBytes } from '@/lib/helpers'

/** Shown wherever a value is missing. */
export const NO_VALUE = '—'

/** Tier options for the list filter, with "all" as the default. */
export const BACKUP_TIER_FILTERS = ['all', ...SELF_HOSTED_BACKUP_TIERS] as const

export type SelfHostedBackupTierFilter = (typeof BACKUP_TIER_FILTERS)[number]

export function isBackupTierFilter(value: string): value is SelfHostedBackupTierFilter {
  return (BACKUP_TIER_FILTERS as readonly string[]).includes(value)
}

/** Display name of a retention tier. */
export function getBackupTierLabel(tier: SelfHostedBackupTier): string {
  switch (tier) {
    case '6h':
      return 'Six-hourly'
    case 'daily':
      return 'Daily'
    case 'monthly':
      return 'Monthly'
  }
}

/** Display name of a filter option, including the "all" pseudo-tier. */
export function getBackupTierFilterLabel(filter: SelfHostedBackupTierFilter): string {
  return filter === 'all' ? 'All' : getBackupTierLabel(filter)
}

/** Display name of a generation's completeness. */
export function getBackupStatusLabel(status: SelfHostedBackupStatus): string {
  return status === 'COMPLETED' ? 'Completed' : 'Incomplete'
}

/** Narrows a listing to a single tier, or returns it untouched for "all". */
export function filterBackupsByTier(
  backups: SelfHostedBackup[],
  filter: SelfHostedBackupTierFilter
): SelfHostedBackup[] {
  if (filter === 'all') return backups
  return backups.filter((backup) => backup.tier === filter)
}

/** Comma-separated database names, or the placeholder when none were dumped. */
export function formatDatabaseList(databases: string[]): string {
  return databases.length === 0 ? NO_VALUE : databases.join(', ')
}

/** Byte count of a backup or file, or the placeholder when it isn't usable. */
export function formatBackupSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return NO_VALUE
  return formatBytes(bytes)
}

/** Pluralized file count, e.g. "1 file" or "5 files". */
export function formatFileCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return NO_VALUE
  const rounded = Math.round(count)
  return `${rounded} ${rounded === 1 ? 'file' : 'files'}`
}

/** Pluralized hours, trimmed of a trailing ".0" so whole hours read cleanly. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return NO_VALUE
  const value = Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
  return `${value} ${hours === 1 ? 'hour' : 'hours'}`
}

/**
 * The window a backup is expected within. The listing is only considered stale
 * once twice the expected interval has passed, so a single missed run doesn't
 * raise a warning.
 */
export function getStaleThresholdHours(expectedIntervalHours: number): number {
  return expectedIntervalHours * 2
}

/** Explains why the listing is flagged as stale. */
export function getStaleDescription(expectedIntervalHours: number): string {
  return `No completed backup in the last ${formatHours(getStaleThresholdHours(expectedIntervalHours))}.`
}

/** Relative time for a timestamp, or the placeholder when there isn't one. */
export function formatRelativeTime(timestamp: string | null | undefined): string {
  if (!timestamp) return NO_VALUE
  const parsed = dayjs(timestamp)
  return parsed.isValid() ? parsed.fromNow() : NO_VALUE
}
