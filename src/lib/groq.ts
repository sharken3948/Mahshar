import Groq from 'groq-sdk';

const _groqKey = process.env.GROQ_API_KEY;
if (!_groqKey) {
  throw new Error('GROQ_API_KEY environment variable is required');
}
export const groq = new Groq({ apiKey: _groqKey });

export interface ScoreResult {
  score: number;
  suggested_price: number;
  approved: boolean;
  critical_issues: string[];
  warnings: string[];
  positives: string[];
  summary: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedStrings(value: unknown, maxItems = 50): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || item.length > 1000)) return null
  return value as string[]
}

export function validateScoreResult(value: unknown): ScoreResult {
  const input = record(value)
  if (!input || typeof input.score !== 'number' || !Number.isInteger(input.score) || input.score < 1 || input.score > 10 ||
    typeof input.suggested_price !== 'number' || !Number.isFinite(input.suggested_price) || input.suggested_price < 0 || input.suggested_price > 1_000_000 ||
    typeof input.approved !== 'boolean' || typeof input.summary !== 'string' || input.summary.length < 1 || input.summary.length > 2000) {
    throw new Error('Groq returned invalid score schema')
  }
  const critical_issues = boundedStrings(input.critical_issues)
  const warnings = boundedStrings(input.warnings)
  const positives = boundedStrings(input.positives)
  if (!critical_issues || !warnings || !positives) throw new Error('Groq returned invalid score schema')
  return { score: input.score, suggested_price: input.suggested_price, approved: input.approved,
    critical_issues, warnings, positives, summary: input.summary }
}

export interface RealTestResult {
  success: boolean;
  status?: number;
  latency_ms?: number;
  body?: unknown;
  error?: string;
  response_snippet?: string;
  declared_expected?: boolean;
}

interface ScoreListing {
  name: string;
  category: string;
  description: string;
  endpoint_url?: string;
  example_request?: string;
  example_response?: string;
}

export async function scoreApi(listing: ScoreListing, realTestResult?: RealTestResult): Promise<ScoreResult> {
  let testSection = '';
  if (realTestResult) {
    if (realTestResult.success) {
      const bodyStr = realTestResult.body != null
        ? JSON.stringify(realTestResult.body).slice(0, 500)
        : 'empty';
      testSection = `
Real Endpoint Test: PASSED (HTTP ${realTestResult.status}, ${realTestResult.latency_ms}ms)
Actual Response Body: ${bodyStr}

Compare the actual response body above against the Example Response. If they meaningfully differ (different structure, missing fields, or different data format), add a warning about the discrepancy.

CONTENT SAFETY: Examine the Actual Response Body carefully. If it contains any of the following, set approved=false and add a clear entry to critical_issues explaining what was found:
- Illegal content (e.g. CSAM, instructions for illegal weapons or drugs)
- Hate speech or content targeting people based on race, religion, gender, sexuality, or ethnicity
- Sexually explicit or pornographic material
- Personally Identifiable Information (PII) such as real names, addresses, SSNs, credit card numbers, or passwords exposed in bulk
- Detailed instructions for self-harm, violence, or terrorism
- Malware, exploit code, or phishing content
If none of the above are present, do not mention content safety in your response.`;
    } else {
      const declaredNote = realTestResult.declared_expected
        ? '\n\nNote: the seller has explicitly declared this HTTP status code as an expected response for their endpoint (not a bug). Treat it as intentional behaviour and weigh the response accordingly — the endpoint is behaving as the seller advertised.'
        : '';
      testSection = `
Real Endpoint Test: FAILED — ${realTestResult.error ?? 'unknown error'}${realTestResult.status ? ` (HTTP ${realTestResult.status})` : ''}

The endpoint did not respond correctly during automated testing. Add a warning about this in the warnings array, but do NOT automatically block approval — weigh it alongside all other quality signals.${declaredNote}`;
    }
  }

  const prompt = `You are a strict API marketplace security and quality reviewer.

API Name: ${listing.name}
Category: ${listing.category}
Description: ${listing.description}
Endpoint URL: ${listing.endpoint_url ?? 'not provided'}
Example Request: ${listing.example_request ?? 'not provided'}
Example Response: ${listing.example_response ?? 'not provided'}${testSection}

Analyze this API listing carefully. Return ONLY a valid JSON object with NO markdown, NO backticks, NO explanation:
{
  "score": <integer 1-10>,
  "suggested_price": <decimal like 0.001>,
  "approved": <true if no critical issues, false if any critical issues exist>,
  "critical_issues": [<list any harmful/malicious/dangerous content issues OR content safety violations found in the response body, or empty array []>],
  "warnings": [<list minor issues that should be fixed, or empty array []>],
  "positives": [<list what is good about this API>],
  "summary": "<one sentence overall assessment>"
}`;

  let completion
  try {
    completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Groq API error (scoreApi): ${message}`)
  }

  const content = completion.choices[0]?.message?.content ?? '{}'
  try {
    return validateScoreResult(JSON.parse(content))
  } catch {
    throw new Error(`Groq returned invalid JSON (scoreApi): ${content.slice(0, 200)}`)
  }
}

export interface MatchResult {
  api_ids: string[];
  reasoning: string;
}

export function validateMatchResult(value: unknown, candidateIds: ReadonlySet<string>): MatchResult {
  const input = record(value)
  if (!input || !Array.isArray(input.api_ids) || input.api_ids.length > 20 ||
    input.api_ids.some(id => typeof id !== 'string' || id.length > 128) ||
    typeof input.reasoning !== 'string' || input.reasoning.length < 1 || input.reasoning.length > 2000) {
    throw new Error('Groq returned invalid match schema')
  }
  const api_ids = [...new Set((input.api_ids as string[]).filter(id => candidateIds.has(id)))].slice(0, 5)
  return { api_ids, reasoning: input.reasoning }
}

export async function matchApis(
  query: string,
  apis: Array<{ id: string; name: string; description: string; category: string }>
): Promise<MatchResult> {
  const apiList = apis
    .map((a) => `ID: ${a.id} | Name: ${a.name} | Category: ${a.category} | Description: ${a.description}`)
    .join('\n');

  const prompt = `A buyer is searching for APIs with this natural language query: "${query}"

Available APIs:
${apiList}

Return the best matching API IDs (up to 5) sorted by relevance. Respond with valid JSON only:
{
  "api_ids": ["<id1>", "<id2>"],
  "reasoning": "<brief explanation>"
}`;

  let completion
  try {
    completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Groq API error (matchApis): ${message}`)
  }

  const content = completion.choices[0]?.message?.content ?? '{}'
  try {
    return validateMatchResult(JSON.parse(content), new Set(apis.map(api => api.id)))
  } catch {
    throw new Error(`Groq returned invalid JSON (matchApis): ${content.slice(0, 200)}`)
  }
}
