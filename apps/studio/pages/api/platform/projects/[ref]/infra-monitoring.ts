import { NextApiRequest, NextApiResponse } from 'next'
import { ZodError } from 'zod'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { isSelfHostedMetricsEnabled } from '@/lib/api/self-hosted/constants'
import {
  getInfraMonitoring,
  type GetInfraMonitoringVariables,
} from '@/lib/api/self-hosted/metrics/infra-monitoring'
import { PrometheusError } from '@/lib/api/self-hosted/metrics/prometheus'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

/** Response the endpoint keeps returning while Prometheus is not configured. */
const EMPTY_RESPONSE = {
  data: [],
  yAxisLimit: 0,
  format: '%',
  total: 0,
}

/**
 * Collects the requested attribute names. The client serializes the array as a
 * single comma-separated `attributes` parameter (openapi-fetch, `style: form`
 * with `explode: false`), but repeated keys and the `attributes[]` spelling are
 * accepted too so the endpoint can be called by hand. Values are only split and
 * trimmed here; `getInfraMonitoring` checks them against its allowlist.
 */
function parseAttributes(query: NextApiRequest['query']): string[] {
  const raw = [query.attributes, query['attributes[]']].flatMap((value) => {
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  })

  return raw
    .flatMap((value) => value.split(','))
    .map((attribute) => attribute.trim())
    .filter((attribute) => attribute.length > 0)
}

/** First value of a query parameter, so a repeated key cannot change its type. */
function parseSingle(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function toValidationMessage(error: ZodError): string {
  const message = error.issues
    .map((issue) => {
      const path = issue.path.join('.')
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')

  return message.length > 0 ? message : 'Invalid request parameters'
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  // Without Prometheus there is no data source, so the endpoint answers with the
  // same empty payload it always has.
  if (!isSelfHostedMetricsEnabled()) {
    return res.status(200).json(EMPTY_RESPONSE)
  }

  // The query string is untyped: `getInfraMonitoring` validates it with zod and
  // throws a ZodError, which is answered with a 400 below.
  const variables = {
    attributes: parseAttributes(req.query),
    startDate: parseSingle(req.query.startDate),
    endDate: parseSingle(req.query.endDate),
    interval: parseSingle(req.query.interval),
  } as unknown as GetInfraMonitoringVariables

  try {
    const response = await getInfraMonitoring(variables)

    return res.status(200).json(response)
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ data: null, error: { message: toValidationMessage(error) } })
    }

    // The message is already normalized to a kind of failure and never contains
    // the Prometheus URL or its credentials.
    if (error instanceof PrometheusError) {
      return res.status(502).json({ data: null, error: { message: error.message } })
    }

    return res
      .status(500)
      .json({ data: null, error: { message: 'Unable to retrieve infrastructure metrics' } })
  }
}
