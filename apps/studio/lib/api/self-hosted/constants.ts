// Constants specific to self-hosted environments

// Schemas exposed via PostgREST Data API, read from the PGRST_DB_SCHEMAS env var
// that is passed to the Studio container via docker-compose / CLI.
export const DEFAULT_EXPOSED_SCHEMAS = process.env.PGRST_DB_SCHEMAS ?? 'public,graphql_public'

export const ENCRYPTION_KEY = process.env.PG_META_CRYPTO_KEY || 'SAMPLE_KEY'
export const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT || '5432', 10)
export const POSTGRES_HOST = process.env.POSTGRES_HOST || 'db'
export const POSTGRES_DATABASE = process.env.POSTGRES_DB || 'postgres'
export const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'postgres'
export const POSTGRES_USER_READ_WRITE = process.env.POSTGRES_USER_READ_WRITE || 'supabase_admin'
export const POSTGRES_USER_READ_ONLY =
  process.env.POSTGRES_USER_READ_ONLY || 'supabase_read_only_user'

// Fallback used when AUTH_JWT_SECRET is not provided to the Studio container
// (e.g. local dev without docker-compose). The string is the same default
// shipped by the supabase/cli — keep them in sync.
export const DEFAULT_AUTH_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
export const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || DEFAULT_AUTH_JWT_SECRET

/** Drops trailing slashes so a base URL and a path never join into a double slash. */
function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

// Health check endpoints for the services that ship with the self-hosted
// docker-compose stack. Studio reaches every service directly over the compose
// network, so the defaults are the compose service names. Set any of these to
// an empty string to mark that service as disabled and skip the check.
export const SERVICE_HEALTH_AUTH_URL =
  process.env.SERVICE_HEALTH_AUTH_URL ?? 'http://auth:9999/health'
export const SERVICE_HEALTH_REST_URL =
  process.env.SERVICE_HEALTH_REST_URL ?? 'http://rest:3001/ready'
export const SERVICE_HEALTH_REALTIME_URL =
  process.env.SERVICE_HEALTH_REALTIME_URL ??
  'http://realtime-dev.supabase-realtime:4000/api/tenants/realtime-dev/health'
export const SERVICE_HEALTH_STORAGE_URL =
  process.env.SERVICE_HEALTH_STORAGE_URL ?? 'http://storage:5000/status'
export const SERVICE_HEALTH_FUNCTIONS_URL =
  process.env.SERVICE_HEALTH_FUNCTIONS_URL ?? 'http://functions:9000/'
export const SERVICE_HEALTH_META_URL =
  process.env.SERVICE_HEALTH_META_URL ??
  `${trimTrailingSlashes(process.env.STUDIO_PG_META_URL || 'http://meta:8080')}/health`
export const SERVICE_HEALTH_POOLER_URL =
  process.env.SERVICE_HEALTH_POOLER_URL ?? 'http://supavisor:4000/api/health'
export const SERVICE_HEALTH_API_GATEWAY_URL =
  process.env.SERVICE_HEALTH_API_GATEWAY_URL ??
  `${trimTrailingSlashes(process.env.SUPABASE_URL || 'http://api-gw:8000')}/`

// Token sent to the Realtime tenant health endpoint, which requires an
// authenticated request. Empty when the stack has no anon key configured, in
// which case the check is sent without an Authorization header.
export const SERVICE_HEALTH_REALTIME_TOKEN = process.env.SUPABASE_ANON_KEY ?? ''

// Upper bound for a single health check, in milliseconds. A missing or
// malformed value falls back to the default rather than producing NaN.
const DEFAULT_SERVICE_HEALTH_TIMEOUT_MS = 3000
const parsedServiceHealthTimeoutMs = Number.parseInt(
  process.env.SERVICE_HEALTH_TIMEOUT_MS ?? '',
  10
)
export const SERVICE_HEALTH_TIMEOUT_MS =
  Number.isFinite(parsedServiceHealthTimeoutMs) && parsedServiceHealthTimeoutMs > 0
    ? parsedServiceHealthTimeoutMs
    : DEFAULT_SERVICE_HEALTH_TIMEOUT_MS

// Metrics (Prometheus). Powers the compute/infra charts and the home Requests
// chart in a self-hosted stack. Everything below is inert by default: without
// METRICS_PROMETHEUS_URL the existing stub / Logflare behavior is kept.

/** Reads an env var and treats a blank value as unset. */
function readOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : undefined
}

/** Base URL of the Prometheus server, e.g. `http://prometheus:9090`. */
export const METRICS_PROMETHEUS_URL = readOptionalEnv(process.env.METRICS_PROMETHEUS_URL)

export const METRICS_GATEWAYS = ['envoy', 'kong'] as const

export type MetricsGateway = (typeof METRICS_GATEWAYS)[number]

/**
 * Which gateway exposes the per-service request counters that Prometheus
 * scrapes. An unrecognized value falls back to the compose default rather than
 * failing the whole route.
 */
function resolveMetricsGateway(): MetricsGateway {
  const configured = readOptionalEnv(process.env.METRICS_GATEWAY)
  return (METRICS_GATEWAYS as readonly string[]).includes(configured ?? '')
    ? (configured as MetricsGateway)
    : 'envoy'
}

export const METRICS_GATEWAY = resolveMetricsGateway()

export const METRICS_REQUESTS_SOURCES = ['prometheus', 'logflare', 'disabled'] as const

export type MetricsRequestsSource = (typeof METRICS_REQUESTS_SOURCES)[number]

/**
 * Data source for the home Requests chart (`usage.api-counts`). An explicit
 * METRICS_REQUESTS_SOURCE wins when it names a known source; otherwise
 * Prometheus is preferred over Logflare, and the chart is hidden when neither
 * is configured.
 */
function resolveMetricsRequestsSource(): MetricsRequestsSource {
  const configured = readOptionalEnv(process.env.METRICS_REQUESTS_SOURCE)
  if (
    configured !== undefined &&
    (METRICS_REQUESTS_SOURCES as readonly string[]).includes(configured)
  ) {
    return configured as MetricsRequestsSource
  }

  if (METRICS_PROMETHEUS_URL !== undefined) return 'prometheus'
  // LOGFLARE_URL is what lib/constants/api.ts derives PROJECT_ANALYTICS_URL
  // from; it is read here directly to keep this module free of app imports.
  if (readOptionalEnv(process.env.LOGFLARE_URL) !== undefined) return 'logflare'
  return 'disabled'
}

export const METRICS_REQUESTS_SOURCE = resolveMetricsRequestsSource()

// Upper bound for a single Prometheus request, in milliseconds. A missing or
// malformed value falls back to the default rather than producing NaN.
const DEFAULT_METRICS_TIMEOUT_MS = 5000
const parsedMetricsTimeoutMs = Number.parseInt(process.env.METRICS_TIMEOUT_MS ?? '', 10)
export const METRICS_TIMEOUT_MS =
  Number.isFinite(parsedMetricsTimeoutMs) && parsedMetricsTimeoutMs > 0
    ? parsedMetricsTimeoutMs
    : DEFAULT_METRICS_TIMEOUT_MS

/** node-exporter `mountpoint` label that disk usage is reported for. */
export const METRICS_DISK_MOUNTPOINT = readOptionalEnv(process.env.METRICS_DISK_MOUNTPOINT) ?? '/'

/** node-exporter `device` label pattern that network I/O is summed over. */
export const METRICS_NETWORK_DEVICE_REGEX =
  readOptionalEnv(process.env.METRICS_NETWORK_DEVICE_REGEX) ?? '^(eth|en|ens|enp).*'

/** True when Prometheus is configured, which is what gates every metrics route. */
export function isSelfHostedMetricsEnabled(): boolean {
  return METRICS_PROMETHEUS_URL !== undefined
}

// Backup listing (lib/api/self-hosted/backups/*). Studio never creates backups:
// it lists what the host's cron already uploaded to an S3-compatible bucket and
// hands out short-lived download URLs. The credentials below are expected to be
// read-only and scoped to that single bucket.

/** Normalizes a key prefix so that it always ends in a single slash. */
function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

/** S3-compatible endpoint, e.g. `https://<account_id>.r2.cloudflarestorage.com`. */
export const BACKUPS_S3_ENDPOINT = readOptionalEnv(process.env.BACKUPS_S3_ENDPOINT)
export const BACKUPS_S3_BUCKET = readOptionalEnv(process.env.BACKUPS_S3_BUCKET)
export const BACKUPS_S3_ACCESS_KEY_ID = readOptionalEnv(process.env.BACKUPS_S3_ACCESS_KEY_ID)
export const BACKUPS_S3_SECRET_ACCESS_KEY = readOptionalEnv(
  process.env.BACKUPS_S3_SECRET_ACCESS_KEY
)

/** SigV4 region. Cloudflare R2 signs with `auto`. */
export const BACKUPS_S3_REGION = readOptionalEnv(process.env.BACKUPS_S3_REGION) ?? 'auto'

/** Key prefix the database backup generations live under. */
export const BACKUPS_S3_PREFIX = withTrailingSlash(
  readOptionalEnv(process.env.BACKUPS_S3_PREFIX) ?? 'db/'
)

/** Key prefix of the storage volume sync. Unset hides the storage summary. */
const configuredBackupsStoragePrefix = readOptionalEnv(process.env.BACKUPS_STORAGE_PREFIX)
export const BACKUPS_STORAGE_PREFIX =
  configuredBackupsStoragePrefix === undefined
    ? undefined
    : withTrailingSlash(configuredBackupsStoragePrefix)

// How often a new generation is expected. Twice this window without one marks
// the latest backup as stale in the dashboard.
const DEFAULT_BACKUPS_EXPECTED_INTERVAL_HOURS = 6
const parsedBackupsExpectedIntervalHours = Number.parseFloat(
  process.env.BACKUPS_EXPECTED_INTERVAL_HOURS ?? ''
)
export const BACKUPS_EXPECTED_INTERVAL_HOURS =
  Number.isFinite(parsedBackupsExpectedIntervalHours) && parsedBackupsExpectedIntervalHours > 0
    ? parsedBackupsExpectedIntervalHours
    : DEFAULT_BACKUPS_EXPECTED_INTERVAL_HOURS

// Upper bound for a single request to the bucket, in milliseconds. A missing or
// malformed value falls back to the default rather than producing NaN.
const DEFAULT_BACKUPS_TIMEOUT_MS = 10000
const parsedBackupsTimeoutMs = Number.parseInt(process.env.BACKUPS_TIMEOUT_MS ?? '', 10)
export const BACKUPS_TIMEOUT_MS =
  Number.isFinite(parsedBackupsTimeoutMs) && parsedBackupsTimeoutMs > 0
    ? parsedBackupsTimeoutMs
    : DEFAULT_BACKUPS_TIMEOUT_MS

// Lifetime of a presigned download URL, in seconds. SigV4 rejects an expiry
// beyond seven days, so the configured value is clamped to a range that always
// signs successfully.
const DEFAULT_BACKUPS_DOWNLOAD_URL_TTL_SECONDS = 600
const MIN_BACKUPS_DOWNLOAD_URL_TTL_SECONDS = 60
const MAX_BACKUPS_DOWNLOAD_URL_TTL_SECONDS = 604800
const parsedBackupsDownloadUrlTtlSeconds = Number.parseInt(
  process.env.BACKUPS_DOWNLOAD_URL_TTL_SECONDS ?? '',
  10
)
export const BACKUPS_DOWNLOAD_URL_TTL_SECONDS = Math.min(
  MAX_BACKUPS_DOWNLOAD_URL_TTL_SECONDS,
  Math.max(
    MIN_BACKUPS_DOWNLOAD_URL_TTL_SECONDS,
    Number.isFinite(parsedBackupsDownloadUrlTtlSeconds) && parsedBackupsDownloadUrlTtlSeconds > 0
      ? parsedBackupsDownloadUrlTtlSeconds
      : DEFAULT_BACKUPS_DOWNLOAD_URL_TTL_SECONDS
  )
)

// Page cap for ListObjectsV2, which returns up to 1000 objects per page. Hitting
// it truncates the listing instead of walking a bucket without end.
const DEFAULT_BACKUPS_MAX_LIST_PAGES = 20
const parsedBackupsMaxListPages = Number.parseInt(process.env.BACKUPS_MAX_LIST_PAGES ?? '', 10)
export const BACKUPS_MAX_LIST_PAGES =
  Number.isFinite(parsedBackupsMaxListPages) && parsedBackupsMaxListPages > 0
    ? parsedBackupsMaxListPages
    : DEFAULT_BACKUPS_MAX_LIST_PAGES

/** True once an endpoint, a bucket and a credential pair are all configured. */
export function isSelfHostedBackupsEnabled(): boolean {
  return (
    BACKUPS_S3_ENDPOINT !== undefined &&
    BACKUPS_S3_BUCKET !== undefined &&
    BACKUPS_S3_ACCESS_KEY_ID !== undefined &&
    BACKUPS_S3_SECRET_ACCESS_KEY !== undefined
  )
}

// Product areas hidden from the self-hosted dashboard. A deployment that does
// not run, say, Auth or Edge Functions can drop their navigation entries
// instead of leaving links to services that are switched off. The values are
// the dashboard's own feature keys (`project_auth:all`,
// `project_edge_function:all`, `project_storage:all`, `realtime:all`), which
// the profile endpoint reports as `disabled_features`.
//
// Hiding an area removes its navigation entries and related widgets. The pages
// themselves stay reachable by URL, which matches how the same flags behave on
// the hosted dashboard.
export const STUDIO_DISABLED_FEATURES = (process.env.STUDIO_DISABLED_FEATURES ?? '')
  .split(',')
  .map((feature) => feature.trim())
  .filter((feature) => feature.length > 0)
