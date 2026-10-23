import Link from 'next/link'
import { notFound } from 'next/navigation'
import { NavBar } from '@/components/NavBar'
import { ProviderOAuthControls } from '@/components/ProviderOAuthControls'

export const metadata = { title: 'Provider account connection', robots: { index: false, follow: false } }

export default async function ProviderConnectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()
  return <><NavBar /><main className="mx-auto w-full max-w-2xl p-6">
    <h1>Provider account connection</h1>
    <p>Use the wallet that will purchase API calls. Check the account mode before connecting.
      Buyer accounts are available only to that wallet. Seller accounts are managed by the listing owner.</p>
    <ProviderOAuthControls apiId={id} />
    <p><Link href="/buyer">Return to the marketplace</Link></p>
  </main></>
}
