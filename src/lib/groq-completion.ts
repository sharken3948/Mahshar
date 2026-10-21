import 'server-only'
import type { ChatCompletionCreateParamsNonStreaming as Completion } from 'groq-sdk/resources/chat/completions'
import { groq } from '@/lib/groq-neutral'
import { reserveResource, resourceLimit, resourceBudgetEnabled, ResourceBudgetError } from '@/lib/resource-budget'

export type AiResource = 'match' | 'score' | 'background'

/** All real inference, including retries, reserves shared capacity before contacting Groq. */
export async function budgetedCompletion(feature: AiResource, input: Completion) {
  // Preserve canonical SDK parameters and avoid any new database dependency
  // until actual workloads and every ceiling have been approved.
  if (!resourceBudgetEnabled('GROQ')) return groq.chat.completions.create(input)
  if (input.messages.some(message => typeof message.content !== 'string') || input.tools?.length) throw new ResourceBudgetError(true)
  const promptBytes = Buffer.byteLength(JSON.stringify(input.messages), 'utf8')
  if (promptBytes > resourceLimit('MAHSHAR_GROQ_MAX_PROMPT_BYTES')) throw new ResourceBudgetError(false)
  const outputCap = resourceLimit('MAHSHAR_GROQ_MAX_OUTPUT_TOKENS')
  const requestedOutput = input.max_completion_tokens ?? input.max_tokens ?? outputCap
  if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) throw new ResourceBudgetError(true)
  const output = Math.min(requestedOutput, outputCap)
  // Conservative accounting units: serialized UTF-8 bytes plus output ceiling and framing.
  // Reservations are never refunded: provider timeouts can still have consumed tokens.
  const units = promptBytes + output + 1024
  const dailyUnits = resourceLimit('MAHSHAR_GROQ_UNITS_DAY')
  const release = await reserveResource({
    buckets: [
      { scope: 'groq:minute', window_seconds: 60, request_limit: resourceLimit('MAHSHAR_GROQ_REQUESTS_MINUTE'), unit_limit: dailyUnits },
      { scope: 'groq:day', window_seconds: 86400, request_limit: resourceLimit('MAHSHAR_GROQ_REQUESTS_DAY'), unit_limit: dailyUnits },
      { scope: `groq:${feature}:day`, window_seconds: 86400,
        request_limit: resourceLimit(`MAHSHAR_GROQ_${feature.toUpperCase()}_REQUESTS_DAY`),
        unit_limit: resourceLimit(`MAHSHAR_GROQ_${feature.toUpperCase()}_UNITS_DAY`) },
    ], units, leaseScope: 'groq:all', concurrency: resourceLimit('MAHSHAR_GROQ_CONCURRENCY', undefined, 32),
  })
  try {
    const { max_tokens: _legacy, ...parameters } = input
    return await groq.chat.completions.create({ ...parameters, max_completion_tokens: output })
  } finally {
    await release()
  }
}
