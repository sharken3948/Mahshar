import type { Metadata } from 'next'
import { OperationsShell } from '../operations/operations-shell'
export const metadata: Metadata = { title: 'Free API Worker | Mahshar Admin' }
export default function Layout({ children }: { children: React.ReactNode }) { return <OperationsShell>{children}</OperationsShell> }
