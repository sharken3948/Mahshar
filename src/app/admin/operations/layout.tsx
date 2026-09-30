import type { Metadata } from 'next'
import { OperationsShell } from './operations-shell'

export const metadata: Metadata = {
  title: 'Operations | Mahshar Admin',
  description: 'Read-only Mahshar Mainnet operations visibility.',
}

export default function OperationsLayout({ children }: { children: React.ReactNode }) {
  return <OperationsShell>{children}</OperationsShell>
}
