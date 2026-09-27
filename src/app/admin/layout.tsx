import { AdminAccess } from '@/components/AdminAccess'
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminAccess>{children}</AdminAccess>
}
