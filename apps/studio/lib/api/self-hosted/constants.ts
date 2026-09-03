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
