import type { Metadata } from 'next'
import { OperationsShell } from '../operations/operations-shell'

export const metadata: Metadata = {
  title: 'Maintenance Watch | Mahshar Admin',
  description: 'Manual, read-only dependency and infrastructure update checks.',
}

export default function MaintenanceLayout({ children }: { children: React.ReactNode }) {
  return <OperationsShell>{children}</OperationsShell>
}
