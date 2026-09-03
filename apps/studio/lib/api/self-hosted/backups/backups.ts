import {
  BACKUPS_EXPECTED_INTERVAL_HOURS,
  BACKUPS_MAX_LIST_PAGES,
  BACKUPS_S3_PREFIX,
  BACKUPS_STORAGE_PREFIX,
} from '../constants'
import { assertSelfHosted } from '../util'
import {
  SELF_HOSTED_BACKUP_TIERS,
  selfHostedBackupsResponseSchema,
  type SelfHostedBackup,
  type SelfHostedBackupFile,
  type SelfHostedBackupsResponse,
  type SelfHostedBackupsStorage,
  type SelfHostedBackupTier,
} from './backups.types'
import { listAllObjects, type S3Object } from './s3'

// Turns the flat object listing of the backup bucket into the generations the
// dashboard shows. Studio only reads: the host's cron owns creating, copying and
// pruning these objects.

/** Timestamp every generation directory is named after, e.g. `20260101T060000Z`. */
const STAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/

/** Suffix of the per-database dumps written by `pg_dump -Fc`. */
const DUMP_SUFFIX = '.dump.age'

/** Files the cron writes once per generation, next to the per-database dumps. */
const CHECKSUM_FILE = 'MANIFEST.sha256'
const GLOBALS_FILE = 'globals.sql.age'
const CONFIG_FILE = 'config.tar.gz.age'
const DATABASES_FILE = 'DATABASES.txt'

const SINGLETON_FILES = [CHECKSUM_FILE, GLOBALS_FILE, CONFIG_FILE, DATABASES_FILE]

/** Files that must all be present for a generation to count as COMPLETED. */
const REQUIRED_FILES = [CHECKSUM_FILE, GLOBALS_FILE, CONFIG_FILE]

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

/** Code point ordering, so the listing does not shift with the runtime's locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

type ParsedBackupKey = {
  tier: SelfHostedBackupTier
  stamp: string
  fileName: string
}

function isBackupTier(value: string): value is SelfHostedBackupTier {
  return (SELF_HOSTED_BACKUP_TIERS as readonly string[]).includes(value)
}

/** Converts `YYYYMMDDTHHMMSSZ` into an ISO 8601 timestamp, or undefined. */
function stampToIso(stamp: string): string | undefined {
  const match = STAMP_PATTERN.exec(stamp)
  if (match === null) return undefined

  const [, year, month, day, hours, minutes, seconds] = match
  const isoCandidate = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.000Z`
  const parsed = new Date(isoCandidate)
  // Rejects values that match the shape but are not real dates, e.g. month 13.
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

/**
 * Reads `<prefix><tier>/.../<STAMP>/<file>` off an object key. Anything else in
 * the bucket, such as a stray file at the root, is ignored.
 */
function parseBackupKey(key: string, prefix: string): ParsedBackupKey | undefined {
  if (!key.startsWith(prefix)) return undefined

  const segments = key.slice(prefix.length).split('/')
  // A tier, a stamp and a file name at the very least.
  if (segments.length < 3) return undefined

  const tier = segments[0]
  const fileName = segments[segments.length - 1]
  const stamp = segments[segments.length - 2]

  if (!isBackupTier(tier) || fileName.length === 0) return undefined
  if (stampToIso(stamp) === undefined) return undefined

  return { tier, stamp, fileName }
}

/** True for the file names a generation is expected to contain. */
function isKnownBackupFileName(fileName: string): boolean {
  if (SINGLETON_FILES.includes(fileName)) return true

  return fileName.length > DUMP_SUFFIX.length && fileName.endsWith(DUMP_SUFFIX)
}

/** Latest of a set of ISO timestamps, comparing them as dates. */
function maxTimestamp(timestamps: string[]): string | null {
  let latest: string | null = null
  let latestValue = Number.NEGATIVE_INFINITY

  for (const timestamp of timestamps) {
    const value = new Date(timestamp).getTime()
    if (Number.isNaN(value)) continue
    if (value > latestValue) {
      latestValue = value
      latest = timestamp
    }
  }

  return latest
}

/**
 * Groups the object listing into generations, newest first.
 *
 * `latest` is the newest completed six-hourly generation, which is the one the
 * cron writes on a schedule; the daily and monthly tiers are server-side copies
 * of it. `isStale` marks that no such generation has landed within twice the
 * expected interval — with no completed generation at all there is nothing to
 * compare against, and the dashboard shows its empty state instead.
 */
export function groupBackupObjects(
  objects: S3Object[],
  {
    prefix,
    expectedIntervalHours,
    now,
  }: { prefix: string; expectedIntervalHours: number; now: Date }
): { backups: SelfHostedBackup[]; latest: SelfHostedBackup | null; isStale: boolean } {
  const generations = new Map<
    string,
    { tier: SelfHostedBackupTier; createdAt: string; files: SelfHostedBackupFile[] }
  >()

  for (const object of objects) {
    const parsed = parseBackupKey(object.key, prefix)
    if (parsed === undefined) continue

    const createdAt = stampToIso(parsed.stamp)
    if (createdAt === undefined) continue

    const id = `${parsed.tier}/${parsed.stamp}`
    const generation = generations.get(id) ?? { tier: parsed.tier, createdAt, files: [] }
    generation.files.push({
      name: parsed.fileName,
      key: object.key,
      size: object.size,
      lastModified: object.lastModified,
    })
    generations.set(id, generation)
  }

  const backups: SelfHostedBackup[] = [...generations.entries()].map(([id, generation]) => {
    const files = [...generation.files].sort((left, right) => compareStrings(left.name, right.name))
    const fileNames = new Set(files.map((file) => file.name))

    const databases = files
      .filter((file) => file.name.length > DUMP_SUFFIX.length && file.name.endsWith(DUMP_SUFFIX))
      .map((file) => file.name.slice(0, -DUMP_SUFFIX.length))
      .sort((left, right) => compareStrings(left, right))

    const hasEveryRequiredFile = REQUIRED_FILES.every((fileName) => fileNames.has(fileName))

    return {
      id,
      tier: generation.tier,
      createdAt: generation.createdAt,
      // Falls back to the stamp when no file carries a usable timestamp.
      uploadedAt: maxTimestamp(files.map((file) => file.lastModified)) ?? generation.createdAt,
      status: hasEveryRequiredFile && databases.length > 0 ? 'COMPLETED' : 'INCOMPLETE',
      databases,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      files,
    }
  })

  backups.sort((left, right) => {
    const difference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    // Same stamp across tiers: order by id so the listing stays stable.
    return difference !== 0 ? difference : compareStrings(left.id, right.id)
  })

  const latest =
    backups.find((backup) => backup.tier === '6h' && backup.status === 'COMPLETED') ?? null

  const staleAfter = now.getTime() - expectedIntervalHours * 2 * MILLISECONDS_PER_HOUR
  const isStale = latest !== null && new Date(latest.createdAt).getTime() < staleAfter

  return { backups, latest, isStale }
}

/** Rolls the storage sync listing up into the counters the dashboard shows. */
export function summarizeStorageObjects(
  objects: S3Object[],
  isTruncated: boolean
): SelfHostedBackupsStorage {
  return {
    latestModifiedAt: maxTimestamp(objects.map((object) => object.lastModified)),
    objectCount: objects.length,
    totalBytes: objects.reduce((total, object) => total + object.size, 0),
    isTruncated,
  }
}

/**
 * Checks that a key may be downloaded. Only the keys the listing itself returns
 * are allowed, so a caller cannot turn the download route into a reader for the
 * rest of the bucket.
 */
export function isAllowedDownloadKey(key: string): boolean {
  if (key.length === 0 || key.startsWith('/')) return false
  // Rejects traversal both as a whole segment and inside an encoded-looking one.
  if (key.includes('..')) return false

  if (BACKUPS_STORAGE_PREFIX !== undefined && key.startsWith(BACKUPS_STORAGE_PREFIX)) {
    return key.length > BACKUPS_STORAGE_PREFIX.length && !key.endsWith('/')
  }

  const parsed = parseBackupKey(key, BACKUPS_S3_PREFIX)
  if (parsed === undefined) return false

  return isKnownBackupFileName(parsed.fileName)
}

/**
 * Lists every backup generation in the bucket. Server-side only: it signs its
 * requests with the bucket credentials.
 */
export async function listBackups({
  now = new Date(),
}: { now?: Date } = {}): Promise<SelfHostedBackupsResponse> {
  assertSelfHosted()

  const database = await listAllObjects({
    prefix: BACKUPS_S3_PREFIX,
    maxPages: BACKUPS_MAX_LIST_PAGES,
  })

  const storagePrefix = BACKUPS_STORAGE_PREFIX
  const storage =
    storagePrefix === undefined
      ? null
      : await listAllObjects({ prefix: storagePrefix, maxPages: BACKUPS_MAX_LIST_PAGES }).then(
          (result) => summarizeStorageObjects(result.objects, result.isTruncated)
        )

  const { backups, latest, isStale } = groupBackupObjects(database.objects, {
    prefix: BACKUPS_S3_PREFIX,
    expectedIntervalHours: BACKUPS_EXPECTED_INTERVAL_HOURS,
    now,
  })

  return selfHostedBackupsResponseSchema.parse({
    backups,
    latest,
    isStale,
    expectedIntervalHours: BACKUPS_EXPECTED_INTERVAL_HOURS,
    isTruncated: database.isTruncated,
    storage,
    generatedAt: now.toISOString(),
  })
}
