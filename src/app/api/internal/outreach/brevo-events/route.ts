import { handleBrevoDeliveryWebhook } from '@/lib/admin-outreach/delivery-events'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  return handleBrevoDeliveryWebhook(request)
}
