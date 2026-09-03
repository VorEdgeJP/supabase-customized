import { describe, expect, test } from 'vitest'

import {
  BACKUP_TIER_FILTERS,
  filterBackupsByTier,
  formatBackupSize,
  formatDatabaseList,
  formatFileCount,
  formatHours,
  formatRelativeTime,
  getBackupStatusLabel,
  getBackupTierFilterLabel,
  getBackupTierLabel,
  getStaleDescription,
  getStaleThresholdHours,
  isBackupTierFilter,
  NO_VALUE,
} from './SelfHostedBackups.utils'
import type { SelfHostedBackup } from '@/lib/api/self-hosted/backups/backups.types'

const backup = (id: string, tier: SelfHostedBackup['tier']): SelfHostedBackup => ({
  id,
  tier,
  createdAt: '2026-09-03T00:00:00.000Z',
  uploadedAt: '2026-09-03T00:04:00.000Z',
  status: 'COMPLETED',
  databases: ['postgres'],
  totalBytes: 1024,
  files: [],
})

describe('BACKUP_TIER_FILTERS', () => {
  test('offers every tier plus the "all" default', () => {
    expect(BACKUP_TIER_FILTERS).toEqual(['all', '6h', 'daily', 'monthly'])
  })
})

describe('isBackupTierFilter', () => {
  test.each(BACKUP_TIER_FILTERS)('accepts %s', (filter) => {
    expect(isBackupTierFilter(filter)).toBe(true)
  })

  test('rejects anything else', () => {
    expect(isBackupTierFilter('')).toBe(false)
    expect(isBackupTierFilter('weekly')).toBe(false)
  })
})

describe('getBackupTierLabel', () => {
  test.each([
    ['6h', 'Six-hourly'],
    ['daily', 'Daily'],
    ['monthly', 'Monthly'],
  ] as const)('labels %s as %s', (tier, label) => {
    expect(getBackupTierLabel(tier)).toBe(label)
  })
})

describe('getBackupTierFilterLabel', () => {
  test('labels the "all" option', () => {
    expect(getBackupTierFilterLabel('all')).toBe('All')
  })

  test('falls through to the tier label for a real tier', () => {
    expect(getBackupTierFilterLabel('daily')).toBe('Daily')
  })
})

describe('getBackupStatusLabel', () => {
  test('labels both statuses', () => {
    expect(getBackupStatusLabel('COMPLETED')).toBe('Completed')
    expect(getBackupStatusLabel('INCOMPLETE')).toBe('Incomplete')
  })
})

describe('filterBackupsByTier', () => {
  const backups = [backup('a', '6h'), backup('b', 'daily'), backup('c', 'monthly')]

  test('returns everything for "all"', () => {
    expect(filterBackupsByTier(backups, 'all')).toEqual(backups)
  })

  test('narrows to a single tier', () => {
    expect(filterBackupsByTier(backups, 'daily').map((item) => item.id)).toEqual(['b'])
  })

  test('returns an empty list when no generation matches', () => {
    expect(filterBackupsByTier([backup('a', '6h')], 'monthly')).toEqual([])
  })
})

describe('formatDatabaseList', () => {
  test('joins names with commas', () => {
    expect(formatDatabaseList(['postgres', '_supabase'])).toBe('postgres, _supabase')
  })

  test('falls back to the placeholder when empty', () => {
    expect(formatDatabaseList([])).toBe(NO_VALUE)
  })
})

describe('formatBackupSize', () => {
  test('formats a byte count', () => {
    expect(formatBackupSize(0)).toBe('0 bytes')
    expect(formatBackupSize(1024)).toBe('1 KB')
  })

  test('falls back to the placeholder for unusable values', () => {
    expect(formatBackupSize(null)).toBe(NO_VALUE)
    expect(formatBackupSize(undefined)).toBe(NO_VALUE)
    expect(formatBackupSize(-1)).toBe(NO_VALUE)
    expect(formatBackupSize(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('formatFileCount', () => {
  test('pluralizes', () => {
    expect(formatFileCount(0)).toBe('0 files')
    expect(formatFileCount(1)).toBe('1 file')
    expect(formatFileCount(5)).toBe('5 files')
  })

  test('falls back to the placeholder for unusable values', () => {
    expect(formatFileCount(-1)).toBe(NO_VALUE)
    expect(formatFileCount(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('formatHours', () => {
  test('pluralizes whole hours', () => {
    expect(formatHours(1)).toBe('1 hour')
    expect(formatHours(12)).toBe('12 hours')
  })

  test('keeps one decimal for fractional hours', () => {
    expect(formatHours(1.5)).toBe('1.5 hours')
  })

  test('falls back to the placeholder for unusable values', () => {
    expect(formatHours(Number.NaN)).toBe(NO_VALUE)
  })
})

describe('getStaleThresholdHours', () => {
  test('doubles the expected interval', () => {
    expect(getStaleThresholdHours(6)).toBe(12)
  })
})

describe('getStaleDescription', () => {
  test('names the doubled window', () => {
    expect(getStaleDescription(6)).toBe('No completed backup in the last 12 hours.')
  })
})

describe('formatRelativeTime', () => {
  test('formats a timestamp relative to now', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(oneHourAgo)).toBe('an hour ago')
  })

  test('falls back to the placeholder for a missing or invalid timestamp', () => {
    expect(formatRelativeTime(null)).toBe(NO_VALUE)
    expect(formatRelativeTime(undefined)).toBe(NO_VALUE)
    expect(formatRelativeTime('not-a-timestamp')).toBe(NO_VALUE)
  })
})
