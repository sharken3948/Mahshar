import { groq } from '@/lib/groq';

// Shared by crawl and retest routes — keeps Groq model/prompt in one place
export async function scoreForDiscovery(
  name: string,
  description: string,
): Promise<{ score: number; reason: string }> {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host === '[::1]') return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 127 || a === 255) return false;        // loopback / broadcast
    if (a === 10) return false;                                  // RFC1918 class A
    if (a === 172 && b >= 16 && b <= 31) return false;          // RFC1918 class B
    if (a === 192 && b === 168) return false;                    // RFC1918 class C
    if (a === 169 && b === 254) return false;                    // link-local / AWS metadata
  }
  return true;
}
