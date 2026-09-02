import { safeSql } from '@supabase/pg-meta'

import {
  SERVICE_HEALTH_API_GATEWAY_URL,
  SERVICE_HEALTH_AUTH_URL,
  SERVICE_HEALTH_FUNCTIONS_URL,
  SERVICE_HEALTH_META_URL,
  SERVICE_HEALTH_POOLER_URL,
  SERVICE_HEALTH_REALTIME_TOKEN,
  SERVICE_HEALTH_REALTIME_URL,
  SERVICE_HEALTH_REST_URL,
  SERVICE_HEALTH_STORAGE_URL,
  SERVICE_HEALTH_TIMEOUT_MS,
} from './constants'
import { executeQuery } from './query'
import {
  SELF_HOSTED_SERVICE_NAMES,
  type SelfHostedServiceHealth,
  type SelfHostedServiceName,
} from './service-health.types'
import { assertSelfHosted } from './util'

// Health checks for the services that run alongside Studio in a self-hosted
// docker-compose stack. Only call these from server-side self-hosted code.

type HttpServiceCheck = {
  name: SelfHostedServiceName
  url: string
  headers?: Record<string, string>
  /**
   * Treat any HTTP response as healthy, regardless of its status code. Used for
   * services that have no dedicated health endpoint, where reaching the process
   * at all is the signal we are after.
   */
  acceptAnyResponse?: boolean
}

// The version string returned by `select version()`, e.g. "PostgreSQL 15.8 ...".
const DATABASE_VERSION_QUERY = safeSql`select version()`

/** Sentinel resolved by the database check's timer when the query does not answer in time. */
const DATABASE_TIMEOUT = Symbol('service-health-database-timeout')

/** Reads a string property off a thrown value without asserting its type. */
function getStringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  const candidate = Reflect.get(value, property)
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * Turns a thrown fetch error into a message that reads well in the dashboard.
 * Aborts surface as a DOMException, which is not an Error subclass in every
 * runtime, so the shape is probed rather than narrowed with instanceof.
 */
function getRequestErrorMessage(error: unknown): string {
  const name = getStringProperty(error, 'name')
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `Timed out after ${SERVICE_HEALTH_TIMEOUT_MS}ms`
  }

  const cause =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'cause') : undefined
  // undici reports the OS-level reason on the cause, not on the thrown TypeError.
  const code = getStringProperty(error, 'code') ?? getStringProperty(cause, 'code')

  if (code === 'ECONNREFUSED') return 'Connection refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found'
  if (code === 'ECONNRESET') return 'Connection reset'
  if (code !== undefined) return code

  return getStringProperty(error, 'message') ?? 'Unknown error'
}

/**
 * Checks that a configured URL can be parsed. A malformed value makes `fetch`
 * throw a message containing the URL itself, which may carry credentials, so it
 * is caught here instead of being echoed back to the browser.
 */
function isParsableUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function buildResult(
  name: SelfHostedServiceName,
  result: Omit<SelfHostedServiceHealth, 'name' | 'checkedAt'>
): SelfHostedServiceHealth {
  return { name, checkedAt: new Date().toISOString(), ...result }
}

export async function checkHttpService({
  name,
  url,
  headers,
  acceptAnyResponse = false,
}: HttpServiceCheck): Promise<SelfHostedServiceHealth> {
  if (url.length === 0) {
    return buildResult(name, { status: 'DISABLED', latencyMs: null })
  }

  if (!isParsableUrl(url)) {
    return buildResult(name, {
      status: 'UNHEALTHY',
      latencyMs: null,
      error: 'Invalid health check URL',
    })
  }

  const startedAt = performance.now()

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(SERVICE_HEALTH_TIMEOUT_MS),
    })
    const latencyMs = Math.round(performance.now() - startedAt)

    // The body is never used, so release the connection instead of buffering it.
    try {
      await response.body?.cancel()
    } catch {
      // Cancelling an already-consumed body is not an error worth reporting.
    }

    if (!response.ok && !acceptAnyResponse) {
      return buildResult(name, {
        status: 'UNHEALTHY',
        latencyMs,
        error: `Responded with HTTP ${response.status}`,
      })
    }

    return buildResult(name, { status: 'ACTIVE_HEALTHY', latencyMs })
  } catch (error) {
    return buildResult(name, {
      status: 'UNHEALTHY',
      latencyMs: null,
      error: getRequestErrorMessage(error),
    })
  }
}

export async function checkDatabase(): Promise<SelfHostedServiceHealth> {
  const startedAt = performance.now()
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    // `executeQuery` accepts no abort signal, so the check is bounded by racing
    // it against a timer instead. A hung pool or a saturated Postgres accepts
    // the connection and never answers, which must not stall the response.
    const timedOut = new Promise<typeof DATABASE_TIMEOUT>((resolve) => {
      timeoutId = setTimeout(() => resolve(DATABASE_TIMEOUT), SERVICE_HEALTH_TIMEOUT_MS)
    })

    // Hardcoded query with no user input; the database is reached through pg-meta.
    // Connects as the read-write user, which is what the rest of Studio uses. The
    // read-only user is optional in self-hosted stacks and often does not exist.
    const result = await Promise.race([
      executeQuery<{ version?: unknown }>({
        query: DATABASE_VERSION_QUERY,
        readOnly: false,
      }),
      timedOut,
    ])

    if (result === DATABASE_TIMEOUT) {
      return buildResult('db', {
        status: 'UNHEALTHY',
        latencyMs: null,
        error: `Timed out after ${SERVICE_HEALTH_TIMEOUT_MS}ms`,
      })
    }

    const { data, error } = result
    const latencyMs = Math.round(performance.now() - startedAt)

    if (error) {
      return buildResult('db', {
        status: 'UNHEALTHY',
        latencyMs,
        error: `Could not reach the database through pg-meta: ${error.message}`,
      })
    }

    const version = data?.[0]?.version
    return buildResult('db', {
      status: 'ACTIVE_HEALTHY',
      latencyMs,
      ...(typeof version === 'string' ? { info: { version } } : {}),
    })
  } catch (error) {
    return buildResult('db', {
      status: 'UNHEALTHY',
      latencyMs: null,
      error: `Could not reach the database through pg-meta: ${getRequestErrorMessage(error)}`,
    })
  } finally {
    // Leaving the timer pending would keep the event loop alive after the check.
    clearTimeout(timeoutId)
  }
}

function checkService(name: SelfHostedServiceName): Promise<SelfHostedServiceHealth> {
  switch (name) {
    case 'db':
      return checkDatabase()
    case 'auth':
      return checkHttpService({ name, url: SERVICE_HEALTH_AUTH_URL })
    case 'rest':
      return checkHttpService({ name, url: SERVICE_HEALTH_REST_URL })
    case 'realtime':
      // The tenant health endpoint requires a token; without one it would answer
      // 401 and read as an outage rather than as missing configuration.
      return checkHttpService({
        name,
        url: SERVICE_HEALTH_REALTIME_URL,
        headers:
          SERVICE_HEALTH_REALTIME_TOKEN.length > 0
            ? { Authorization: `Bearer ${SERVICE_HEALTH_REALTIME_TOKEN}` }
            : undefined,
      })
    case 'storage':
      return checkHttpService({ name, url: SERVICE_HEALTH_STORAGE_URL })
    case 'functions':
      // Edge Runtime has no health endpoint on `/`, so any HTTP response counts.
      return checkHttpService({
        name,
        url: SERVICE_HEALTH_FUNCTIONS_URL,
        acceptAnyResponse: true,
      })
    case 'meta':
      return checkHttpService({ name, url: SERVICE_HEALTH_META_URL })
    case 'pooler':
      return checkHttpService({ name, url: SERVICE_HEALTH_POOLER_URL })
    case 'api_gateway':
      // The gateway answers `/` with 404, which still proves it is routing.
      return checkHttpService({
        name,
        url: SERVICE_HEALTH_API_GATEWAY_URL,
        acceptAnyResponse: true,
      })
  }
}

/**
 * Runs every requested check in parallel. A slow service cannot hold up the
 * response beyond SERVICE_HEALTH_TIMEOUT_MS.
 */
export async function checkAllServices(
  names: readonly SelfHostedServiceName[] = SELF_HOSTED_SERVICE_NAMES
): Promise<SelfHostedServiceHealth[]> {
  assertSelfHosted()

  const results = await Promise.allSettled(names.map((name) => checkService(name)))

  return results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value

    return buildResult(names[index], {
      status: 'UNHEALTHY',
      latencyMs: null,
      error: getRequestErrorMessage(result.reason),
    })
  })
}
