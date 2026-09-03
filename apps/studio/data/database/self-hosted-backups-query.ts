import { queryOptions, useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { databaseKeys } from './keys'
import { fetchHandler } from '@/data/fetchers'
import {
  selfHostedBackupsResponseSchema,
  type SelfHostedBackupsResponse,
} from '@/lib/api/self-hosted/backups/backups.types'
import { BASE_PATH, IS_PLATFORM } from '@/lib/constants'
import { ResponseError } from '@/types'

/** Listings are cheap but the bucket only changes when the cron runs. */
const STALE_TIME = 60_000
/** Poll interval, comfortably shorter than the shortest retention tier. */
const REFETCH_INTERVAL = 5 * 60_000

// The API route answers with `{ data: null, error: { message } }`; `apiWrapper`
// answers with `{ error }` on an unhandled failure. A flat `{ message }` is
// accepted too, so an error from any other layer still reaches the UI.
const errorBodySchema = z.union([
  z.object({ error: z.object({ message: z.string() }) }).transform((body) => body.error.message),
  z.object({ message: z.string() }).transform((body) => body.message),
])

export type SelfHostedBackupsVariables = {
  projectRef?: string
}

export type SelfHostedBackupsData = SelfHostedBackupsResponse
export type SelfHostedBackupsError = ResponseError

async function getSelfHostedBackups(
  { projectRef }: SelfHostedBackupsVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')

  const response = await fetchHandler(
    `${BASE_PATH}/api/platform/projects/${projectRef}/self-hosted/backups`,
    { signal }
  )

  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    const parsedBody = errorBodySchema.safeParse(body)
    throw new ResponseError(
      parsedBody.success ? parsedBody.data : 'Failed to retrieve backups',
      response.status
    )
  }

  return selfHostedBackupsResponseSchema.parse(await response.json())
}

export const selfHostedBackupsQueryOptions = ({ projectRef }: SelfHostedBackupsVariables) =>
  queryOptions<SelfHostedBackupsData, SelfHostedBackupsError>({
    queryKey: databaseKeys.selfHostedBackups(projectRef),
    queryFn: ({ signal }) => getSelfHostedBackups({ projectRef }, signal),
    enabled: !IS_PLATFORM && Boolean(projectRef),
    staleTime: STALE_TIME,
    refetchInterval: REFETCH_INTERVAL,
  })

export const useSelfHostedBackupsQuery = ({ projectRef }: SelfHostedBackupsVariables) =>
  useQuery(selfHostedBackupsQueryOptions({ projectRef }))
