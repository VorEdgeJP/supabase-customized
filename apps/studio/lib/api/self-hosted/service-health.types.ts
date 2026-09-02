import { z } from 'zod'

// Shared between the self-hosted service health API route (server) and the
// Studio query hook (client). Kept free of server-only imports so it can be
// bundled into the browser.

export const SELF_HOSTED_SERVICE_NAMES = [
  'db',
  'auth',
  'rest',
  'realtime',
  'storage',
  'functions',
  'meta',
  'pooler',
  'api_gateway',
] as const

export type SelfHostedServiceName = (typeof SELF_HOSTED_SERVICE_NAMES)[number]

export const SELF_HOSTED_SERVICE_STATUSES = ['ACTIVE_HEALTHY', 'UNHEALTHY', 'DISABLED'] as const

export type SelfHostedServiceStatus = (typeof SELF_HOSTED_SERVICE_STATUSES)[number]

export const selfHostedServiceHealthSchema = z.object({
  name: z.enum(SELF_HOSTED_SERVICE_NAMES),
  status: z.enum(SELF_HOSTED_SERVICE_STATUSES),
  /** Round-trip time of the health check in milliseconds, null when the check did not complete. */
  latencyMs: z.number().nullable(),
  /** ISO 8601 timestamp of when the check finished. */
  checkedAt: z.string(),
  /** Human-readable reason when the service is UNHEALTHY. */
  error: z.string().optional(),
  /** Metadata returned by the service itself (e.g. version). */
  info: z.record(z.string(), z.unknown()).optional(),
})

export type SelfHostedServiceHealth = z.infer<typeof selfHostedServiceHealthSchema>

export const selfHostedServiceHealthResponseSchema = z.object({
  services: z.array(selfHostedServiceHealthSchema),
})

export type SelfHostedServiceHealthResponse = z.infer<typeof selfHostedServiceHealthResponseSchema>

export function isSelfHostedServiceName(value: string): value is SelfHostedServiceName {
  return (SELF_HOSTED_SERVICE_NAMES as readonly string[]).includes(value)
}
