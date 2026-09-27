import { groq } from '@/lib/groq';
import { isOutboundUrlShapeAllowed } from '@/lib/outbound-fetch';

// Shared by crawl and retest routes — keeps Groq model/prompt in one place
export async function scoreForDiscovery(
  name: string,
  description: string,
): Promise<{ score: number; reason: string }> {
  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'user',
        content:
          `Rate this API from 1 to 10 based on usefulness, clarity, and developer appeal.\n` +
          `API Name: ${name}\nDescription: ${description}\n` +
          `Return ONLY valid JSON with no markdown: {"score": <integer 1-10>, "reason": "<one sentence>"}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });
  const content = completion.choices[0]?.message?.content ?? '{"score":5,"reason":"unknown"}';
  try {
    return JSON.parse(content) as { score: number; reason: string };
  } catch {
    return { score: 5, reason: 'Groq returned invalid JSON' };
  }
}

// Rejects non-HTTPS and private/loopback/link-local URLs (SSRF protection)
export function isSafeUrl(url: string): boolean {
  return isOutboundUrlShapeAllowed(url);
}
