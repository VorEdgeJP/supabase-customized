import { NextApiRequest, NextApiResponse } from 'next'
import { ZodError } from 'zod'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { listBackups } from '@/lib/api/self-hosted/backups/backups'
import type { SelfHostedBackupsResponse } from '@/lib/api/self-hosted/backups/backups.types'
import { S3Error } from '@/lib/api/self-hosted/backups/s3'
import { isSelfHostedBackupsEnabled } from '@/lib/api/self-hosted/constants'

export default function backups(req: NextApiRequest, res: NextApiResponse) {
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

const handleGet = async (_req: NextApiRequest, res: NextApiResponse) => {
  // Without a bucket there is nothing to list, so the route answers as if it
  // does not exist, the same as it does on a platform build.
  if (!isSelfHostedBackupsEnabled()) {
    return res.status(404).json({ data: null, error: { message: 'Backups are not configured' } })
  }

  try {
    const response: SelfHostedBackupsResponse = await listBackups()

    return res.status(200).json(response)
  } catch (error) {
    // S3Error messages are normalized to a category, so they carry no endpoint,
    // object key, credential or signature.
    if (error instanceof S3Error) {
      return res.status(502).json({ data: null, error: { message: error.message } })
    }

    if (error instanceof ZodError) {
      return res
        .status(400)
        .json({ data: null, error: { message: 'The backup listing could not be read' } })
    }

    return res.status(500).json({ data: null, error: { message: 'Failed to list backups' } })
  }
}
