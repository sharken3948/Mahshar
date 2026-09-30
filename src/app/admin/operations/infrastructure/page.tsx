import { SignalPageClient } from '../signal-page-client'

export default function OperationsInfrastructurePage() {
  return <SignalPageClient endpoint="/api/admin/operations/infrastructure" eyebrow="Fixed read-only probes" title="Infrastructure" description="Small, cached production signals with independent timeout and failure boundaries."/>
}
