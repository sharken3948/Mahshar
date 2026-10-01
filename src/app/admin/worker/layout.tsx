import type { Metadata } from 'next'
import { OperationsShell } from '../operations/operations-shell'

export const metadata: Metadata = {
  title: 'Worker Agent | Mahshar Admin',
  description: 'Admin control and durable run visibility for the bounded Worker Agent foundation.',
}

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return <OperationsShell>{children}</OperationsShell>
}
