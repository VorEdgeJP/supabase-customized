import { useParams } from 'common'
import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'

import { SelfHostedBackupsList } from '@/components/interfaces/Database/Backups/SelfHosted/SelfHostedBackupsList'
import DatabaseLayout from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { IS_PLATFORM } from '@/lib/constants'
import type { NextPageWithLayout } from '@/types'

/**
 * Backups for a self-hosted deployment, listed from the bucket the host's cron
 * uploads to. Platform has its own backup pages behind this path, so a platform
 * build sends the visitor on to the scheduled backups page instead.
 */
const DatabaseBackups: NextPageWithLayout = () => {
  const router = useRouter()
  const { ref } = useParams()

  useEffect(() => {
    if (IS_PLATFORM && ref) {
      router.replace(`/project/${ref}/database/backups/scheduled`)
    }
  }, [ref, router])

  if (IS_PLATFORM) return null

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>Database Backups</PageHeaderTitle>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <PageSection>
          <PageSectionContent>
            <SelfHostedBackupsList />
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

DatabaseBackups.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title="Backups">{page}</DatabaseLayout>
  </DefaultLayout>
)

export default DatabaseBackups
