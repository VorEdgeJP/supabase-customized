import { describe, expect, test } from 'vitest'

import { getBackupDetailRows } from './SelfHostedBackupsStat.utils'
import { NO_VALUE } from '@/components/interfaces/Database/Backups/SelfHosted/SelfHostedBackups.utils'
import type {
  SelfHostedBackup,
  SelfHostedBackupsResponse,
} from '@/lib/api/self-hosted/backups/backups.types'

const LATEST: SelfHostedBackup = {
  id: '6h/20260903T000000Z',
  tier: '6h',
  createdAt: '2026-09-03T00:00:00.000Z',
  uploadedAt: '2026-09-03T00:04:00.000Z',
  status: 'COMPLETED',
  databases: ['postgres', '_supabase'],
  totalBytes: 2048,
  files: [
    {
      name: 'postgres.dump.age',
      key: 'db/6h/2026/09/03/20260903T000000Z/postgres.dump.age',
      size: 1024,
      lastModified: '2026-09-03T00:04:00.000Z',
    },
    {
      name: 'globals.sql.age',
      key: 'db/6h/2026/09/03/20260903T000000Z/globals.sql.age',
      size: 1024,
      lastModified: '2026-09-03T00:03:00.000Z',
    },
  ],
}

const response = (
  overrides: Partial<SelfHostedBackupsResponse> = {}
): SelfHostedBackupsResponse => ({
  backups: [LATEST],
  latest: LATEST,
  isStale: false,
  expectedIntervalHours: 6,
  isTruncated: false,
  storage: null,
  generatedAt: '2026-09-03T01:00:00.000Z',
  ...overrides,
})

describe('getBackupDetailRows', () => {
  test('describes the newest completed generation', () => {
    expect(getBackupDetailRows(response())).toEqual([
      { label: 'Tier', value: 'Six-hourly' },
      { label: 'Databases', value: 'postgres, _supabase' },
      { label: 'Size', value: '2 KB' },
      { label: 'Files', value: '2 files' },
      { label: 'Status', value: 'Completed' },
    ])
  })

  test('returns no rows when there is no completed generation and no storage sync', () => {
    expect(getBackupDetailRows(response({ latest: null }))).toEqual([])
  })

  test('appends the storage sync row when a storage prefix is configured', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    const rows = getBackupDetailRows(
      response({
        storage: {
          latestModifiedAt: oneHourAgo,
          objectCount: 10,
          totalBytes: 4096,
          isTruncated: false,
        },
      })
    )

    expect(rows.at(-1)).toEqual({ label: 'Storage sync', value: 'an hour ago' })
  })

  test('shows the placeholder when the storage sync has never run', () => {
    const rows = getBackupDetailRows(
      response({
        latest: null,
        storage: { latestModifiedAt: null, objectCount: 0, totalBytes: 0, isTruncated: false },
      })
    )

    expect(rows).toEqual([{ label: 'Storage sync', value: NO_VALUE }])
  })
})
