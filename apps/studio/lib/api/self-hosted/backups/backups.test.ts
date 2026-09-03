import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  groupBackupObjects,
  isAllowedDownloadKey,
  listBackups,
  summarizeStorageObjects,
} from './backups'
import { listAllObjects, type S3Object } from './s3'

vi.mock('../constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../constants')>()),
  BACKUPS_S3_PREFIX: 'db/',
  BACKUPS_STORAGE_PREFIX: 'storage/current/',
  BACKUPS_EXPECTED_INTERVAL_HOURS: 6,
  BACKUPS_MAX_LIST_PAGES: 20,
}))

vi.mock('../util', () => ({
  assertSelfHosted: vi.fn(),
}))

vi.mock('./s3', () => ({
  listAllObjects: vi.fn(),
}))

const mockListAllObjects = vi.mocked(listAllObjects)

const object = (key: string, size = 100, lastModified = '2026-01-01T06:05:00.000Z'): S3Object => ({
  key,
  size,
  lastModified,
})

/** Every file the cron writes for one generation, under an arbitrary directory. */
const generation = (
  directory: string,
  { databases = ['postgres'] }: { databases?: string[] } = {}
) => [
  object(`${directory}/MANIFEST.sha256`, 1),
  object(`${directory}/globals.sql.age`, 2),
  object(`${directory}/config.tar.gz.age`, 3),
  object(`${directory}/DATABASES.txt`, 4),
  ...databases.map((database) => object(`${directory}/${database}.dump.age`, 10)),
]

const now = new Date('2026-01-01T08:00:00.000Z')
const groupOptions = { prefix: 'db/', expectedIntervalHours: 6, now }

describe('api/self-hosted/backups/backups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('groupBackupObjects', () => {
    it('groups the files of one generation and derives its metadata', () => {
      const { backups } = groupBackupObjects(
        generation('db/6h/2026/01/01/20260101T060000Z'),
        groupOptions
      )

      expect(backups).toHaveLength(1)
      expect(backups[0]).toMatchObject({
        id: '6h/20260101T060000Z',
        tier: '6h',
        createdAt: '2026-01-01T06:00:00.000Z',
        uploadedAt: '2026-01-01T06:05:00.000Z',
        status: 'COMPLETED',
        databases: ['postgres'],
        totalBytes: 20,
      })
      expect(backups[0].files.map((file) => file.name)).toEqual([
        'DATABASES.txt',
        'MANIFEST.sha256',
        'config.tar.gz.age',
        'globals.sql.age',
        'postgres.dump.age',
      ])
      expect(backups[0].files[0].key).toBe('db/6h/2026/01/01/20260101T060000Z/DATABASES.txt')
    })

    it('recognizes the daily and monthly tiers, which sit directly under the tier', () => {
      const { backups } = groupBackupObjects(
        [
          ...generation('db/6h/2026/01/01/20260101T060000Z'),
          ...generation('db/daily/20260101T000000Z'),
          ...generation('db/monthly/20260101T000000Z'),
        ],
        groupOptions
      )

      expect(backups.map((backup) => backup.tier).sort()).toEqual(['6h', 'daily', 'monthly'])
    })

    it('lists every dumped database, sorted', () => {
      const { backups } = groupBackupObjects(
        generation('db/6h/2026/01/01/20260101T060000Z', {
          databases: ['postgres', '_supabase', 'analytics'],
        }),
        groupOptions
      )

      expect(backups[0].databases).toEqual(['_supabase', 'analytics', 'postgres'])
    })

    it('marks a generation missing a required file as INCOMPLETE', () => {
      const files = generation('db/6h/2026/01/01/20260101T060000Z').filter(
        (file) => !file.key.endsWith('MANIFEST.sha256')
      )

      const { backups } = groupBackupObjects(files, groupOptions)

      expect(backups[0].status).toBe('INCOMPLETE')
    })

    it('marks a generation with no database dump as INCOMPLETE', () => {
      const { backups } = groupBackupObjects(
        generation('db/6h/2026/01/01/20260101T060000Z', { databases: [] }),
        groupOptions
      )

      expect(backups[0].status).toBe('INCOMPLETE')
      expect(backups[0].databases).toEqual([])
    })

    it('sorts generations by creation time, newest first', () => {
      const { backups } = groupBackupObjects(
        [
          ...generation('db/6h/2026/01/01/20260101T000000Z'),
          ...generation('db/6h/2026/01/01/20260101T120000Z'),
          ...generation('db/6h/2026/01/01/20260101T060000Z'),
        ],
        groupOptions
      )

      expect(backups.map((backup) => backup.id)).toEqual([
        '6h/20260101T120000Z',
        '6h/20260101T060000Z',
        '6h/20260101T000000Z',
      ])
    })

    it('orders generations sharing a stamp by id so the listing is stable', () => {
      const { backups } = groupBackupObjects(
        [...generation('db/monthly/20260101T000000Z'), ...generation('db/daily/20260101T000000Z')],
        groupOptions
      )

      expect(backups.map((backup) => backup.id)).toEqual([
        'daily/20260101T000000Z',
        'monthly/20260101T000000Z',
      ])
    })

    it('ignores keys outside the prefix, unknown tiers, malformed stamps and directories', () => {
      const { backups } = groupBackupObjects(
        [
          object('other/6h/2026/01/01/20260101T060000Z/globals.sql.age'),
          object('db/weekly/20260101T060000Z/globals.sql.age'),
          object('db/6h/2026/01/01/not-a-stamp/globals.sql.age'),
          object('db/6h/20260101T060000Z'),
          object('db/6h/2026/01/01/20260145T060000Z/globals.sql.age'),
          object('db/6h/2026/01/01/20260101T060000Z/'),
        ],
        groupOptions
      )

      expect(backups).toEqual([])
    })

    it('picks the newest completed six-hourly generation as the latest', () => {
      const { latest } = groupBackupObjects(
        [
          ...generation('db/6h/2026/01/01/20260101T000000Z'),
          ...generation('db/6h/2026/01/01/20260101T060000Z', { databases: [] }),
          ...generation('db/daily/20260101T120000Z'),
        ],
        groupOptions
      )

      expect(latest?.id).toBe('6h/20260101T000000Z')
    })

    it('returns no latest when there is no completed six-hourly generation', () => {
      const { latest, isStale } = groupBackupObjects(
        generation('db/daily/20260101T060000Z'),
        groupOptions
      )

      expect(latest).toBeNull()
      expect(isStale).toBe(false)
    })

    it('returns an empty listing for no objects', () => {
      expect(groupBackupObjects([], groupOptions)).toEqual({
        backups: [],
        latest: null,
        isStale: false,
      })
    })

    it('is not stale exactly at twice the expected interval', () => {
      // now is 08:00, so twice a six hour interval reaches back to 20:00 the day before.
      const { isStale } = groupBackupObjects(
        generation('db/6h/2025/12/31/20251231T200000Z'),
        groupOptions
      )

      expect(isStale).toBe(false)
    })

    it('is stale one second past twice the expected interval', () => {
      const { isStale } = groupBackupObjects(
        generation('db/6h/2025/12/31/20251231T195959Z'),
        groupOptions
      )

      expect(isStale).toBe(true)
    })

    it('honours a different expected interval', () => {
      const { isStale } = groupBackupObjects(generation('db/6h/2026/01/01/20260101T060000Z'), {
        ...groupOptions,
        expectedIntervalHours: 0.5,
      })

      expect(isStale).toBe(true)
    })

    it('falls back to the stamp when no file carries a usable timestamp', () => {
      const { backups } = groupBackupObjects(
        generation('db/6h/2026/01/01/20260101T060000Z').map((file) => ({
          ...file,
          lastModified: 'not-a-date',
        })),
        groupOptions
      )

      expect(backups[0].uploadedAt).toBe('2026-01-01T06:00:00.000Z')
    })

    it('honours a custom prefix', () => {
      const { backups } = groupBackupObjects(
        generation('backups/db/6h/2026/01/01/20260101T060000Z'),
        { ...groupOptions, prefix: 'backups/db/' }
      )

      expect(backups).toHaveLength(1)
    })
  })

  describe('summarizeStorageObjects', () => {
    it('counts the objects, sums their sizes and keeps the newest timestamp', () => {
      const summary = summarizeStorageObjects(
        [
          object('storage/current/a', 10, '2026-01-01T01:00:00.000Z'),
          object('storage/current/b', 20, '2026-01-01T03:00:00.000Z'),
          object('storage/current/c', 30, '2026-01-01T02:00:00.000Z'),
        ],
        false
      )

      expect(summary).toEqual({
        latestModifiedAt: '2026-01-01T03:00:00.000Z',
        objectCount: 3,
        totalBytes: 60,
        isTruncated: false,
      })
    })

    it('reports an empty sync with no timestamp', () => {
      expect(summarizeStorageObjects([], true)).toEqual({
        latestModifiedAt: null,
        objectCount: 0,
        totalBytes: 0,
        isTruncated: true,
      })
    })
  })

  describe('isAllowedDownloadKey', () => {
    it('allows every file a generation contains', () => {
      const directory = 'db/6h/2026/01/01/20260101T060000Z'

      expect(isAllowedDownloadKey(`${directory}/MANIFEST.sha256`)).toBe(true)
      expect(isAllowedDownloadKey(`${directory}/DATABASES.txt`)).toBe(true)
      expect(isAllowedDownloadKey(`${directory}/globals.sql.age`)).toBe(true)
      expect(isAllowedDownloadKey(`${directory}/config.tar.gz.age`)).toBe(true)
      expect(isAllowedDownloadKey(`${directory}/postgres.dump.age`)).toBe(true)
      expect(isAllowedDownloadKey('db/daily/20260101T000000Z/postgres.dump.age')).toBe(true)
      expect(isAllowedDownloadKey('db/monthly/20260101T000000Z/postgres.dump.age')).toBe(true)
    })

    it('allows a file under the storage prefix', () => {
      expect(isAllowedDownloadKey('storage/current/stub/avatar.png')).toBe(true)
    })

    it('rejects a key outside both prefixes', () => {
      expect(isAllowedDownloadKey('secrets/env.age')).toBe(false)
      expect(isAllowedDownloadKey('storage/deleted/2026/01/01/avatar.png')).toBe(false)
    })

    it('rejects traversal and absolute keys', () => {
      expect(isAllowedDownloadKey('db/../secrets/env.age')).toBe(false)
      expect(isAllowedDownloadKey('db/6h/2026/01/01/20260101T060000Z/../../env.age')).toBe(false)
      expect(isAllowedDownloadKey('storage/current/../../secrets/env.age')).toBe(false)
      expect(isAllowedDownloadKey('/db/6h/2026/01/01/20260101T060000Z/globals.sql.age')).toBe(false)
      expect(isAllowedDownloadKey('')).toBe(false)
    })

    it('rejects a pre-encoded traversal under the backup prefix', () => {
      expect(isAllowedDownloadKey('db/6h/2026/01/01/20260101T060000Z/%2e%2e%2fenv.age')).toBe(false)
      expect(isAllowedDownloadKey('db/%2e%2e/secrets/env.age')).toBe(false)
    })

    it('rejects an unknown file name inside a generation', () => {
      expect(isAllowedDownloadKey('db/6h/2026/01/01/20260101T060000Z/notes.txt')).toBe(false)
      expect(isAllowedDownloadKey('db/6h/2026/01/01/20260101T060000Z/.dump.age')).toBe(false)
    })

    it('rejects an unknown tier, a malformed stamp and a directory key', () => {
      expect(isAllowedDownloadKey('db/weekly/20260101T060000Z/globals.sql.age')).toBe(false)
      expect(isAllowedDownloadKey('db/6h/2026/01/01/nope/globals.sql.age')).toBe(false)
      expect(isAllowedDownloadKey('db/6h/2026/01/01/20260101T060000Z/')).toBe(false)
      expect(isAllowedDownloadKey('storage/current/')).toBe(false)
    })
  })

  describe('listBackups', () => {
    it('lists both prefixes and returns the validated response', async () => {
      mockListAllObjects.mockImplementation(async ({ prefix }) =>
        prefix === 'db/'
          ? { objects: generation('db/6h/2026/01/01/20260101T060000Z'), isTruncated: false }
          : {
              objects: [object('storage/current/avatar.png', 50, '2026-01-01T07:00:00.000Z')],
              isTruncated: false,
            }
      )

      const response = await listBackups({ now })

      expect(mockListAllObjects).toHaveBeenCalledWith({ prefix: 'db/', maxPages: 20 })
      expect(mockListAllObjects).toHaveBeenCalledWith({
        prefix: 'storage/current/',
        maxPages: 20,
      })
      expect(response.backups).toHaveLength(1)
      expect(response.latest?.id).toBe('6h/20260101T060000Z')
      expect(response.isStale).toBe(false)
      expect(response.expectedIntervalHours).toBe(6)
      expect(response.isTruncated).toBe(false)
      expect(response.storage).toEqual({
        latestModifiedAt: '2026-01-01T07:00:00.000Z',
        objectCount: 1,
        totalBytes: 50,
        isTruncated: false,
      })
      expect(response.generatedAt).toBe('2026-01-01T08:00:00.000Z')
    })

    it('reports a truncated database listing', async () => {
      mockListAllObjects.mockResolvedValue({ objects: [], isTruncated: true })

      const response = await listBackups({ now })

      expect(response.isTruncated).toBe(true)
      expect(response.backups).toEqual([])
      expect(response.latest).toBeNull()
    })

    it('propagates a failure from the bucket', async () => {
      mockListAllObjects.mockRejectedValue(new Error('Connection refused'))

      await expect(listBackups({ now })).rejects.toThrowError('Connection refused')
    })

    it('skips the storage listing and returns a null summary when no prefix is set', async () => {
      vi.resetModules()
      vi.doMock('../constants', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../constants')>()),
        BACKUPS_S3_PREFIX: 'db/',
        BACKUPS_STORAGE_PREFIX: undefined,
        BACKUPS_EXPECTED_INTERVAL_HOURS: 6,
        BACKUPS_MAX_LIST_PAGES: 20,
      }))

      const s3 = await import('./s3')
      vi.mocked(s3.listAllObjects).mockResolvedValue({ objects: [], isTruncated: false })
      const { listBackups: listBackupsWithoutStorage } = await import('./backups')

      const response = await listBackupsWithoutStorage({ now })

      expect(response.storage).toBeNull()
      expect(vi.mocked(s3.listAllObjects)).toHaveBeenCalledTimes(1)

      vi.doUnmock('../constants')
      vi.resetModules()
    })
  })
})
