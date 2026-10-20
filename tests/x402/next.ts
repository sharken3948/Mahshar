export { NextRequest, NextResponse } from 'next/server.js'

// Paid routes must finish through durable settlement/delivery records alone.
// Reject scheduling itself, even when a deferred callback would hide errors.
export function after(): never {
  throw new Error('Background transaction scheduling forbidden in paid proxy tests')
}
