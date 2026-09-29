import { groq, GROQ_MODEL, DISCOVERY_PROMPT_SYSTEM, buildDiscoveryPrompt, ensureGroqAvailable } from '@/lib/groq';
import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch';

// Shared by crawl and retest routes — keeps Groq model/prompt in one place.
// A malformed response falls back to score 1 so it sits well below the crawl
// threshold even if that threshold is later relaxed.
export async function scoreForDiscovery(
  name: string,
  description: string,
): Promise<{ score: number; reason: string }> {
  ensureGroqAvailable();
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: DISCOVERY_PROMPT_SYSTEM },
      { role: 'user', content: buildDiscoveryPrompt(name, description) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });
  const content = completion.choices[0]?.message?.content ?? '{"score":1,"reason":"empty groq response"}';
  try {
    const parsed = JSON.parse(content) as { score?: unknown; reason?: unknown };
    const rawScore = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : 1;
    const score = Math.max(1, Math.min(10, Math.round(rawScore)));
    const reason = typeof parsed.reason === 'string' && parsed.reason.length > 0
      ? parsed.reason.slice(0, 500)
      : 'no reason provided';
    return { score, reason };
  } catch {
    return { score: 1, reason: 'malformed groq output' };
  }
}

// Rejects non-HTTPS and private/loopback/link-local URLs (SSRF protection).
export function isSafeUrl(url: string): boolean {
  return isOutboundUrlShapeAllowed(url);
}
