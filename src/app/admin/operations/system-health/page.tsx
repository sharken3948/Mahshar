import { SignalPageClient } from '../signal-page-client'

export default function OperationsSystemHealthPage() {
  return <SignalPageClient endpoint="/api/admin/operations/system-health" eyebrow="Proven state only" title="System Health" description="Configuration, storage readiness, and bounded maintenance backlog evidence without invented success claims."/>
}
