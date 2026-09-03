import { z } from 'zod'

// Shared between the self-hosted backup API routes (server) and the Studio query
// hooks (client). Kept free of server-only imports so it can be bundled into the
// browser. The shape is deliberately independent of the platform `BackupsResponse`,
// which has no object keys or sizes and numbers its backups.

/** Retention tiers written by the host's backup cron. */
export const SELF_HOSTED_BACKUP_TIERS = ['6h', 'daily', 'monthly'] as const

export type SelfHostedBackupTier = (typeof SELF_HOSTED_BACKUP_TIERS)[number]

/**
 * A generation is COMPLETED once every file the cron writes is present, and
 * INCOMPLETE while an upload is still in flight or a run failed part way.
 */
export const SELF_HOSTED_BACKUP_STATUSES = ['COMPLETED', 'INCOMPLETE'] as const

export type SelfHostedBackupStatus = (typeof SELF_HOSTED_BACKUP_STATUSES)[number]

export const selfHostedBackupFileSchema = z.object({
  /** Last path segment, e.g. `globals.sql.age`. */
  name: z.string(),
  /** Full object key, which is what a download request is issued for. */
  key: z.string(),
  size: z.number(),
  /** ISO 8601 timestamp of when the object was uploaded. */
  lastModified: z.string(),
})

export type SelfHostedBackupFile = z.infer<typeof selfHostedBackupFileSchema>

export const selfHostedBackupSchema = z.object({
  /** `<tier>/<STAMP>`, unique across the listing. */
  id: z.string(),
  tier: z.enum(SELF_HOSTED_BACKUP_TIERS),
  /** ISO 8601 timestamp the generation is stamped with. */
  createdAt: z.string(),
  /** ISO 8601 timestamp of the most recently uploaded file in the generation. */
  uploadedAt: z.string(),
  status: z.enum(SELF_HOSTED_BACKUP_STATUSES),
  /** Databases dumped in this generation, read off the `<database>.dump.age` files. */
  databases: z.array(z.string()),
  totalBytes: z.number(),
  files: z.array(selfHostedBackupFileSchema),
})

export type SelfHostedBackup = z.infer<typeof selfHostedBackupSchema>

export const selfHostedBackupsStorageSchema = z.object({
  /** ISO 8601 timestamp of the newest synced object, null when the prefix is empty. */
  latestModifiedAt: z.string().nullable(),
  objectCount: z.number(),
  totalBytes: z.number(),
  /** True when the sync holds more objects than the listing walked. */
  isTruncated: z.boolean(),
})

export type SelfHostedBackupsStorage = z.infer<typeof selfHostedBackupsStorageSchema>

export const selfHostedBackupsResponseSchema = z.object({
  backups: z.array(selfHostedBackupSchema),
  /** Newest completed six-hourly generation, null when there is none. */
  latest: selfHostedBackupSchema.nullable(),
  /** True when the newest backup is older than twice the expected interval. */
  isStale: z.boolean(),
  expectedIntervalHours: z.number(),
  /** True when the bucket holds more objects than the listing walked. */
  isTruncated: z.boolean(),
  /** Summary of the storage volume sync, null when no prefix is configured. */
  storage: selfHostedBackupsStorageSchema.nullable(),
  generatedAt: z.string(),
})

export type SelfHostedBackupsResponse = z.infer<typeof selfHostedBackupsResponseSchema>

export const selfHostedBackupDownloadRequestSchema = z.object({
  key: z.string().min(1),
})

export type SelfHostedBackupDownloadRequest = z.infer<typeof selfHostedBackupDownloadRequestSchema>

export const selfHostedBackupDownloadResponseSchema = z.object({
  /** Presigned, short-lived URL for the encrypted object. */
  fileUrl: z.string(),
})

export type SelfHostedBackupDownloadResponse = z.infer<
  typeof selfHostedBackupDownloadResponseSchema
>
