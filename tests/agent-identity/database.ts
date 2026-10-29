export const database = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  allowed: true, unavailable: false }

export function createServiceClient() {
  return {
    from() { throw new Error('Identity lookup must never access a database table') },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'mahshar_take_rate_limit') throw new Error('Unexpected database operation')
      database.calls.push({ name, args })
      return { data: { allowed: database.allowed, remaining: 29, retry_after_seconds: 60 },
        error: database.unavailable ? { message: 'offline test database unavailable' } : null }
    },
  }
}
