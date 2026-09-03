import { useMutation, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { fetchHandler } from '@/data/fetchers'
import {
  selfHostedBackupDownloadResponseSchema,
  type SelfHostedBackupDownloadResponse,
} from '@/lib/api/self-hosted/backups/backups.types'
import { BASE_PATH } from '@/lib/constants'
import { ResponseError } from '@/types'

// The API route answers with `{ data: null, error: { message } }`; `apiWrapper`
// answers with `{ error }` on an unhandled failure. A flat `{ message }` is
// accepted too, so an error from any other layer still reaches the UI.
const errorBodySchema = z.union([
  z.object({ error: z.object({ message: z.string() }) }).transform((body) => body.error.message),
  z.object({ message: z.string() }).transform((body) => body.message),
])

export type SelfHostedBackupDownloadVariables = {
  projectRef: string
  /** Object key of a file listed by the backups query. */
  key: string
}

export type SelfHostedBackupDownloadData = SelfHostedBackupDownloadResponse
export type SelfHostedBackupDownloadError = ResponseError

async function createSelfHostedBackupDownloadUrl({
  projectRef,
  key,
}: SelfHostedBackupDownloadVariables) {
  const response = await fetchHandler(
    `${BASE_PATH}/api/platform/projects/${projectRef}/self-hosted/backups/download`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }
  )

  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    const parsedBody = errorBodySchema.safeParse(body)
    throw new ResponseError(
      parsedBody.success ? parsedBody.data : 'Failed to create a download link',
      response.status
    )
  }

  return selfHostedBackupDownloadResponseSchema.parse(await response.json())
}

export const useSelfHostedBackupDownloadMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<
    SelfHostedBackupDownloadData,
    SelfHostedBackupDownloadError,
    SelfHostedBackupDownloadVariables
  >,
  'mutationFn'
> = {}) =>
  useMutation<
    SelfHostedBackupDownloadData,
    SelfHostedBackupDownloadError,
    SelfHostedBackupDownloadVariables
  >({
    mutationFn: createSelfHostedBackupDownloadUrl,
    async onSuccess(data, variables, context) {
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to download backup: ${error.message}`)
      } else {
        onError(error, variables, context)
      }
    },
    ...options,
  })
