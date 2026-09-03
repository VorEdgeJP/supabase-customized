import { flexRender, type Row } from '@tanstack/react-table'
import { TableCell, TableRow } from 'ui'

import type { SelfHostedBackup } from '@/lib/api/self-hosted/backups/backups.types'

interface SelfHostedBackupItemProps {
  row: Row<SelfHostedBackup>
}

/** One generation in the backups table. */
export const SelfHostedBackupItem = ({ row }: SelfHostedBackupItemProps) => (
  <TableRow>
    {row.getVisibleCells().map((cell) => (
      <TableCell key={cell.id}>
        {flexRender(cell.column.columnDef.cell, cell.getContext())}
      </TableCell>
    ))}
  </TableRow>
)
