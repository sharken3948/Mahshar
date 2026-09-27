const PAYMENT_MESSAGES: Record<string, string> = {
  payment_storage_unavailable: 'Secure payment recording is temporarily unavailable. No payment was submitted. Please try again later.',
  payment_verification_service_unavailable: 'Circle payment verification is temporarily unavailable. No payment was submitted. Please try again later.',
  payment_storage_or_verification_unavailable: 'Payment recording or verification is temporarily unavailable. Please try again later.',
  payment_processing_unavailable: 'The payment service could not process this authorization. No payment was submitted. Please try again later.',
  verification_failed: 'The payment authorization could not be verified. Check your Arc network and Mahshar Balance, then approve a fresh request.',
  payment_accounting_unavailable: 'The payment may have settled, but its purchase record is still being finalized. Do not approve another payment for this request.',
  settlement_confirmation_pending: 'The payment was submitted, but confirmation is still being recorded. Do not approve another payment for this request.',
  settlement_unknown: 'The payment submission has an uncertain status and needs review. Do not approve another payment for this request.',
  settlement_requires_review: 'The payment needs review before this API can be called. Do not approve another payment for this request.',
  settlement_manual_review: 'This payment is awaiting manual review. Do not approve another payment for this request.',
  settlement_pending: 'This payment is still being finalized. Do not approve another payment for this request.',
  delivery_state_unavailable: 'Payment is accounted, but delivery state could not be recorded. Do not approve another payment.',
  delivery_in_progress: 'Payment is accounted and delivery is in progress. Retry the same proof later; do not approve another payment.',
  delivery_retryable: 'Payment is accounted and the upstream request was not dispatched. The exact same proof and request may be replayed.',
  delivery_failed_final: 'Payment is accounted and the upstream returned a final failure. The request will not be executed again.',
  delivery_outcome_unknown: 'Payment is accounted, but the upstream outcome is unknown. The request will not be executed again automatically.',
}

export function paymentErrorMessage(code?: string, providedMessage?: string, attemptId?: string): string {
  const message = (code && PAYMENT_MESSAGES[code]) || providedMessage || 'The paid API request could not be completed. Please try again.'
  return attemptId ? `${message} Reference: ${attemptId}` : message
}
