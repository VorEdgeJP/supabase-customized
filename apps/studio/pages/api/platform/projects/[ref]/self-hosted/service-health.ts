import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { checkAllServices } from '@/lib/api/self-hosted/service-health'
import {
  isSelfHostedServiceName,
  SELF_HOSTED_SERVICE_NAMES,
  type SelfHostedServiceHealthResponse,
  type SelfHostedServiceName,
} from '@/lib/api/self-hosted/service-health.types'

export default function serviceHealth(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler)
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

/**
 * Parses the optional `services` query parameter. Only names on the allowlist
 * are accepted, so a request can never point the health check at an arbitrary
 * URL, and duplicates are dropped so a single request cannot fan out into more
 * checks than there are services. Returns every service when the parameter is
 * absent.
 */
function parseRequestedServices(
  value: unknown
):
  | { names: readonly SelfHostedServiceName[]; unknownName?: undefined }
  | { names?: undefined; unknownName: string } {
  if (value === undefined) return { names: SELF_HOSTED_SERVICE_NAMES }

  const raw = Array.isArray(value) ? value.join(',') : String(value)
  const requested = [
    ...new Set(
      raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    ),
  ]

  if (requested.length === 0) return { names: SELF_HOSTED_SERVICE_NAMES }

  const names: SelfHostedServiceName[] = []
  for (const name of requested) {
    if (!isSelfHostedServiceName(name)) return { unknownName: name }
    names.push(name)
  }

  return { names }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const { names, unknownName } = parseRequestedServices(req.query.services)

  if (names === undefined) {
    return res.status(400).json({
      data: null,
      error: {
        message: `Unknown service "${unknownName}". Supported services: ${SELF_HOSTED_SERVICE_NAMES.join(', ')}`,
      },
    })
  }

  const services = await checkAllServices(names)
  const response: SelfHostedServiceHealthResponse = { services }

  return res.status(200).json(response)
}
