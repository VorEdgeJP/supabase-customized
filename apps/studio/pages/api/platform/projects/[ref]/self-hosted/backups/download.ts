import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { isAllowedDownloadKey } from '@/lib/api/self-hosted/backups/backups'
import {
  selfHostedBackupDownloadRequestSchema,
  type SelfHostedBackupDownloadResponse,
} from '@/lib/api/self-hosted/backups/backups.types'
import { presignGetObject, S3Error } from '@/lib/api/self-hosted/backups/s3'
import {
  BACKUPS_DOWNLOAD_URL_TTL_SECONDS,
  isSelfHostedBackupsEnabled,
} from '@/lib/api/self-hosted/constants'
import { assertSelfHosted } from '@/lib/api/self-hosted/util'

export default function backupDownload(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler)
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

/**
 * `Content-Disposition` the bucket should answer with, so the browser saves the
 * (encrypted) object under its own file name instead of navigating to it. The
 * key has already passed `isAllowedDownloadKey`, so its last segment is one of
 * the known backup file names; quotes and backslashes are stripped anyway to
 * keep the header well-formed.
 */
export function attachmentDisposition(key: string): string {
  const fileName = (key.split('/').pop() ?? 'backup').replace(/["\\\r\n]/g, '')
  return `attachment; filename="${fileName}"`
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!isSelfHostedBackupsEnabled()) {
    return res.status(404).json({ data: null, error: { message: 'Backups are not configured' } })
  }

  assertSelfHosted()

  const parsedBody = selfHostedBackupDownloadRequestSchema.safeParse(req.body)
  if (!parsedBody.success) {
    return res.status(400).json({ data: null, error: { message: 'A backup key is required' } })
  }

  // Only the keys the listing itself returns can be signed for, so this route
  // cannot be turned into a reader for the rest of the bucket.
  if (!isAllowedDownloadKey(parsedBody.data.key)) {
    return res.status(400).json({ data: null, error: { message: 'Invalid backup key' } })
  }

  try {
    const fileUrl = presignGetObject({
      key: parsedBody.data.key,
      expiresInSeconds: BACKUPS_DOWNLOAD_URL_TTL_SECONDS,
      responseContentDisposition: attachmentDisposition(parsedBody.data.key),
    })
    const response: SelfHostedBackupDownloadResponse = { fileUrl }

    return res.status(200).json(response)
  } catch (error) {
    if (error instanceof S3Error) {
      return res.status(502).json({ data: null, error: { message: error.message } })
    }

    return res
      .status(500)
      .json({ data: null, error: { message: 'Failed to create a download link' } })
  }
}
