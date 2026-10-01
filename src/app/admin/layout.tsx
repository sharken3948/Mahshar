import type { Metadata } from 'next'
import { AdminAccess } from '@/components/AdminAccess'

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminAccess>{children}</AdminAccess>
}
