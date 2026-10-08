export function ProviderMessageId({ value, className }: { value: string | null; className?: string }) {
  if (!value) return null
  return <section>
    <h3>Delivery</h3>
    <dl className={className}>
      <dt>Provider message ID</dt>
      <dd><code>{value}</code></dd>
    </dl>
  </section>
}
