import { useParams } from 'common'
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle } from 'lucide-react'
import { cn, HoverCard, HoverCardContent, HoverCardTrigger } from 'ui'

import {
  formatLatency,
  formatServiceVersion,
  getOverallStatus,
  getOverallStatusLabel,
  getServiceDisplayName,
  getStatusDotClass,
  getStatusMessage,
} from './SelfHostedServiceStatus.utils'
import { AlertError } from '@/components/ui/AlertError'
import { SingleStat } from '@/components/ui/SingleStat'
import { useSelfHostedServiceHealthQuery } from '@/data/service-status/self-hosted-service-health-query'
import type {
  SelfHostedServiceHealth,
  SelfHostedServiceStatus as ServiceStatus,
} from '@/lib/api/self-hosted/service-health.types'

const SERVICE_ROW_CLASS =
  'px-3 py-2 text-xs flex items-start justify-between gap-x-2 border-b last:border-none'

const iconProps = { size: 18, strokeWidth: 1.5 }

/**
 * Mirrors the icons of the platform `StatusIcon`, kept local so the self-hosted
 * bundle doesn't pull in the platform-only queries that module depends on.
 */
const StatusIcon = ({ status }: { status: ServiceStatus }) => {
  switch (status) {
    case 'ACTIVE_HEALTHY':
      return <CheckCircle2 {...iconProps} className="text-brand" />
    case 'DISABLED':
      return <MinusCircle {...iconProps} className="text-foreground-lighter" />
    case 'UNHEALTHY':
      return <AlertTriangle {...iconProps} />
  }
}

const ServiceRow = ({ service }: { service: SelfHostedServiceHealth }) => {
  const latency = formatLatency(service.latencyMs)
  const isUnhealthy = service.status === 'UNHEALTHY'
  const version = formatServiceVersion(service.info?.version)

  return (
    <div className={SERVICE_ROW_CLASS}>
      <div className="flex gap-x-2">
        <StatusIcon status={service.status} />
        <div className="flex-1">
          <p>{getServiceDisplayName(service.name)}</p>
          <p className="text-foreground-light">{getStatusMessage(service.status)}</p>
          {version && <p className="text-foreground-lighter break-words">{version}</p>}
          {isUnhealthy && service.error && (
            <p className="text-foreground-lighter break-words">{service.error}</p>
          )}
        </div>
      </div>
      {latency && <span className="text-foreground-light shrink-0">{latency}</span>}
    </div>
  )
}

export const SelfHostedServiceStatus = () => {
  const { ref } = useParams()
  const { data, error, isLoading, isError } = useSelfHostedServiceHealthQuery({ projectRef: ref })

  if (isLoading) {
    return (
      <SingleStat
        icon={<Loader2 className="animate-spin" size={18} />}
        label={<span>Status</span>}
        value={<span>Checking...</span>}
      />
    )
  }

  if (isError) {
    return (
      <AlertError
        error={error}
        subject="Failed to retrieve service health"
        description="Check that the Studio container can reach the other services on your Docker network."
        hideContactSupport
      />
    )
  }

  // The query is disabled without a project ref, which leaves it pending forever.
  if (!data) return null

  const services = data.services
  const overallStatus = getOverallStatus(services)

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger tabIndex={0}>
        <SingleStat
          icon={
            <div className="grid grid-cols-3 gap-1">
              {services.map((service) => (
                <div
                  key={service.name}
                  className={cn('w-1.5 h-1.5 rounded-full', getStatusDotClass(service.status))}
                />
              ))}
            </div>
          }
          label={<span>Status</span>}
          value={<span>{getOverallStatusLabel(overallStatus)}</span>}
        />
      </HoverCardTrigger>
      <HoverCardContent className="p-0 w-72" side="bottom" align="start">
        {services.map((service) => (
          <ServiceRow key={service.name} service={service} />
        ))}
      </HoverCardContent>
    </HoverCard>
  )
}
