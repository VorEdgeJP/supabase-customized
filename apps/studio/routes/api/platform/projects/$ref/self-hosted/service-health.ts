import { createFileRoute } from '@tanstack/react-router'

import { toWebHandler } from '@/compat/next/api'
import nextHandler from '@/pages/api/platform/projects/[ref]/self-hosted/service-health'

const handler = toWebHandler(nextHandler)

export const Route = createFileRoute('/api/platform/projects/$ref/self-hosted/service-health')({
  server: { handlers: { GET: handler } },
})
