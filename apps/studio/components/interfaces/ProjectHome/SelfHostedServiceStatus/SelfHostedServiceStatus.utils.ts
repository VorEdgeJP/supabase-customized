import type {
  SelfHostedServiceHealth,
  SelfHostedServiceName,
  SelfHostedServiceStatus,
} from '@/lib/api/self-hosted/service-health.types'

export type SelfHostedOverallStatus = 'CHECKING' | 'HEALTHY' | 'UNHEALTHY'

/** Display name for every service the health check covers. */
export const SELF_HOSTED_SERVICE_DISPLAY_NAMES: Record<SelfHostedServiceName, string> = {
  db: 'Database',
  auth: 'Auth',
  rest: 'PostgREST',
  realtime: 'Realtime',
  storage: 'Storage',
  functions: 'Edge Functions',
  meta: 'Postgres Meta',
  pooler: 'Connection Pooler',
  api_gateway: 'API Gateway',
}

export function getServiceDisplayName(name: SelfHostedServiceName): string {
  return SELF_HOSTED_SERVICE_DISPLAY_NAMES[name]
}

/**
 * Aggregates every service into a single status. Services that are intentionally
 * disabled count as operational, and an empty list means the check hasn't
 * reported anything back yet.
 */
export function getOverallStatus(services: SelfHostedServiceHealth[]): SelfHostedOverallStatus {
  if (services.length === 0) return 'CHECKING'
  if (services.some((service) => service.status === 'UNHEALTHY')) return 'UNHEALTHY'
  return 'HEALTHY'
}

export function getOverallStatusLabel(status: SelfHostedOverallStatus): string {
  switch (status) {
    case 'CHECKING':
      return 'Checking...'
    case 'UNHEALTHY':
      return 'Unhealthy'
    case 'HEALTHY':
      return 'Healthy'
  }
}

export function getStatusMessage(status: SelfHostedServiceStatus): string {
  switch (status) {
    case 'ACTIVE_HEALTHY':
      return 'Healthy'
    case 'DISABLED':
      return 'Disabled'
    case 'UNHEALTHY':
      return 'Unhealthy'
  }
}

/**
 * Formats a health check round-trip time for display. Returns undefined when the
 * check didn't complete, so callers can omit the latency entirely.
 */
export function formatLatency(latencyMs: number | null): string | undefined {
  if (latencyMs === null || !Number.isFinite(latencyMs) || latencyMs < 0) return undefined
  return `${Math.round(latencyMs)} ms`
}

/** Tailwind classes for the status dot shown in the summary stat. */
export function getStatusDotClass(status: SelfHostedServiceStatus): string {
  switch (status) {
    case 'ACTIVE_HEALTHY':
      return 'bg-brand'
    case 'DISABLED':
      return 'bg-foreground-lighter'
    case 'UNHEALTHY':
      return 'bg-selection'
  }
}

/**
 * Shortens a version string for the hover card. `select version()` returns the
 * build platform and compiler as well, which is more than the row can show:
 * "PostgreSQL 15.8 (Debian 15.8-1) on x86_64-pc-linux-gnu, compiled by ...".
 */
export function formatServiceVersion(version: unknown): string | undefined {
  if (typeof version !== 'string') return undefined

  const trimmed = version.trim()
  if (trimmed.length === 0) return undefined

  return trimmed.split(' on ')[0]
}
