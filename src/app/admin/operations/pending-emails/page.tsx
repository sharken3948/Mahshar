import type { Metadata } from 'next'
import { PendingEmailsClient } from './pending-emails-client'

export const metadata: Metadata = {
  title: 'Pending Emails | Mahshar Admin',
  description: 'Admin-only manual invitation tracking. Emails are sent externally.',
}
export default function PendingEmailsPage() { return <PendingEmailsClient/> }
