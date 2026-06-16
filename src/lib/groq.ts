import Groq from 'groq-sdk';

export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export interface ScoreResult {
  score: number;
  suggested_price: number;
  reasoning: string;
  strengths: string[];
  weaknesses: string[];
}

export async function scoreApi(
  name: string,
  description: string,
  exampleRequest: string,
  exampleResponse: string,
  endpointUrl: string
): Promise<ScoreResult> {
  const prompt = `You are an API quality evaluator. Score this API listing from 1-10 and suggest a fair price in USDC per call.

API Name: ${name}
Description: ${description}
Endpoint: ${endpointUrl}
Example Request: ${exampleRequest}
Example Response: ${exampleResponse}

Respond with valid JSON only:
{
  "score": <1-10>,
  "suggested_price": <USDC amount, e.g. 0.001>,
  "reasoning": "<brief explanation>",
  "strengths": ["<strength1>", "<strength2>"],
  "weaknesses": ["<weakness1>"]
}`;

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const content = completion.choices[0]?.message?.content ?? '{}';
  return JSON.parse(content) as ScoreResult;
}

export interface MatchResult {
  api_ids: string[];
  reasoning: string;
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

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const content = completion.choices[0]?.message?.content ?? '{}';
  return JSON.parse(content) as MatchResult;
}
