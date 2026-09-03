import { useParams } from 'common'
import { ChevronDown, Download } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui'

import { formatBackupSize } from './SelfHostedBackups.utils'
import { useSelfHostedBackupDownloadMutation } from '@/data/database/self-hosted-backup-download-mutation'
import type { SelfHostedBackup } from '@/lib/api/self-hosted/backups/backups.types'

interface SelfHostedBackupDownloadMenuProps {
  backup: SelfHostedBackup
}

/**
 * Downloads one file out of a generation. Every file is handed over as-is —
 * still encrypted — through a short-lived link the server signs on request.
 */
export const SelfHostedBackupDownloadMenu = ({ backup }: SelfHostedBackupDownloadMenuProps) => {
  const { ref: projectRef } = useParams()

  const { mutate: downloadBackupFile, isPending: isDownloading } =
    useSelfHostedBackupDownloadMutation({
      onSuccess: ({ fileUrl }) => {
        // Trigger the browser download by creating, clicking and removing a temporary anchor
        const tempLink = document.createElement('a')
        tempLink.href = fileUrl
        document.body.appendChild(tempLink)
        tempLink.click()
        document.body.removeChild(tempLink)
      },
    })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          icon={<Download />}
          iconRight={<ChevronDown />}
          loading={isDownloading}
          disabled={!projectRef || backup.files.length === 0 || isDownloading}
        >
          Download
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {backup.files.map((file) => (
          <DropdownMenuItem
            key={file.key}
            className="flex items-center justify-between gap-x-2"
            onSelect={() => {
              if (!projectRef) return
              downloadBackupFile({ projectRef, key: file.key })
            }}
          >
            <span className="truncate">{file.name}</span>
            <span className="text-foreground-lighter shrink-0">{formatBackupSize(file.size)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
