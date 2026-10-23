import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OnboardingForm } from '../../src/components/OnboardingForm'
import { EditListingForm } from '../../src/components/EditListingForm'
import { wallet } from './browser-stubs'

function App() {
  const [listing, setListing] = useState(null)
  const id = new URL(location.href).searchParams.get('edit')
  useEffect(() => {
    if (id) fetch(`/api/apis/${id}`).then(r => r.json()).then(data => setListing(data.api))
  }, [id])
  if (!id) return <OnboardingForm sellerWallet={wallet} />
  if (!listing) return <p>Loading fixture</p>
  return <EditListingForm listing={listing} onClose={() => {}} onListingChange={setListing} />
}
createRoot(document.getElementById('root')).render(<App />)
