import { queryOptions, useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { serviceStatusKeys } from './keys'
import { fetchHandler } from '@/data/fetchers'
import {
  selfHostedServiceHealthResponseSchema,
  type SelfHostedServiceHealthResponse,
} from '@/lib/api/self-hosted/service-health.types'
import { BASE_PATH, IS_PLATFORM } from '@/lib/constants'
import { ResponseError } from '@/types'

/** Poll interval while every service is healthy (or intentionally disabled). */
const HEALTHY_REFETCH_INTERVAL = 30_000
/** Poll interval while at least one service is unhealthy, so recovery shows up quickly. */
const UNHEALTHY_REFETCH_INTERVAL = 5_000

// The API route answers with `{ data: null, error: { message } }`; `apiWrapper`
// answers with `{ error }` on an unhandled failure. A flat `{ message }` is
// accepted too, so an error from any other layer still reaches the UI.
const errorBodySchema = z.union([
  z.object({ error: z.object({ message: z.string() }) }).transform((body) => body.error.message),
  z.object({ message: z.string() }).transform((body) => body.message),
])

export type SelfHostedServiceHealthVariables = {
  projectRef?: string
}

export type SelfHostedServiceHealthData = SelfHostedServiceHealthResponse
export type SelfHostedServiceHealthError = ResponseError

async function getSelfHostedServiceHealth(
  { projectRef }: SelfHostedServiceHealthVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('projectRef is required')

  const response = await fetchHandler(
    `${BASE_PATH}/api/platform/projects/${projectRef}/self-hosted/service-health`,
    { signal }
  )

  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    const parsedBody = errorBodySchema.safeParse(body)
    throw new ResponseError(
      parsedBody.success ? parsedBody.data : 'Failed to retrieve service health',
      response.status
    )
  }

  return selfHostedServiceHealthResponseSchema.parse(await response.json())
}

export const selfHostedServiceHealthQueryOptions = ({
  projectRef,
}: SelfHostedServiceHealthVariables) =>
  queryOptions<SelfHostedServiceHealthData, SelfHostedServiceHealthError>({
    queryKey: serviceStatusKeys.selfHosted(projectRef),
    queryFn: ({ signal }) => getSelfHostedServiceHealth({ projectRef }, signal),
    enabled: !IS_PLATFORM && Boolean(projectRef),
    staleTime: 5000,
    refetchInterval: (query) => {
      const hasUnhealthyService = query.state.data?.services.some(
        (service) => service.status === 'UNHEALTHY'
      )
      return hasUnhealthyService ? UNHEALTHY_REFETCH_INTERVAL : HEALTHY_REFETCH_INTERVAL
    },
  })

export const useSelfHostedServiceHealthQuery = ({ projectRef }: SelfHostedServiceHealthVariables) =>
  useQuery(selfHostedServiceHealthQueryOptions({ projectRef }))
