import { createFileRoute } from '@tanstack/react-router'

import DatabaseBackups from '@/pages/project/[ref]/database/backups'

export const Route = createFileRoute('/project/$ref/database/backups/')({
  component: DatabaseBackupsRoute,
  staticData: {
    databaseLayoutTitle: 'Backups',
  },
})

function DatabaseBackupsRoute() {
  return <DatabaseBackups dehydratedState={undefined} />
}
