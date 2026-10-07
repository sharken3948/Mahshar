import type { Metadata } from 'next'
import { OperationsShell } from '../operations/operations-shell'

export const metadata: Metadata = {
  title: 'Outreach | Mahshar Admin',
  description: 'Manually reviewed outreach drafts for verified Worker leads.',
}
export default function OutreachLayout({ children }: { children: React.ReactNode }) {
  return <OperationsShell>{children}</OperationsShell>
}
