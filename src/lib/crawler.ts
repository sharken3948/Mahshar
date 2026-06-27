const PUBLIC_APIS_README_URL =
  'https://raw.githubusercontent.com/public-apis/public-apis/master/README.md';
const GITHUB_API_BASE = 'https://api.github.com';

export interface PublicApiEntry {
  name: string;
  description: string;
  auth: string;
  https: boolean;
  cors: string;
  link: string;
  category: string;
  api_docs_url: string;
  source_name: string;
}

export interface PaidApiEntry {
  repo_url: string;
  api_name: string;
  owner_github: string;
  owner_email: string | null;
  owner_x: string | null;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  const h: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'mahshar-discovery',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function fetchPublicApis(): Promise<PublicApiEntry[]> {
  const res = await fetch(PUBLIC_APIS_README_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch public-apis README: ${res.status}`);
  const markdown = await res.text();

  const results: PublicApiEntry[] = [];
  let currentCategory = 'Other';

  for (const line of markdown.split(/\r?\n/)) {
    // Category heading (## or ###)
    const headingMatch = line.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      currentCategory = headingMatch[1].trim();
      continue;
    }

    if (!line.startsWith('|')) continue;
    if (/\|[-\s]+\|/.test(line)) continue;     // separator row
    if (/\|\s*API\s*\|/i.test(line)) continue;  // header row

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 5) continue;

    const [nameCell, description, rawAuth, httpsCell, corsCell] = cells;
    const linkMatch = nameCell?.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!linkMatch) continue;

    results.push({
      name: linkMatch[1],
      description: description ?? '',
      auth: (rawAuth ?? '').replace(/`/g, '').trim(),
      https: /yes/i.test(httpsCell ?? ''),
      cors: (corsCell ?? '').replace(/`/g, '').trim(),
      link: linkMatch[2],
      category: currentCategory,
      api_docs_url: linkMatch[2],
      source_name: 'public-apis',
    });
  }

  return results;
}

export async function fetchPublicApiLists(): Promise<PublicApiEntry[]> {
  try {
    const res = await fetch('https://api.publicapis.org/entries', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`publicapis.org returned ${res.status}`);
    const data = await res.json() as {
      entries?: Array<{
        API: string;
        Description: string;
        Auth: string;
        HTTPS: boolean;
        Cors: string;
        Link: string;
        Category: string;
      }>;
    };

    return (data.entries ?? [])
      .filter(e => e.HTTPS && (e.Auth === '' || e.Auth === 'null' || e.Auth === 'No'))
      .map(e => ({
        name: e.API,
        description: e.Description,
        auth: e.Auth,
        https: e.HTTPS,
        cors: e.Cors,
        link: e.Link,
        category: e.Category,
        api_docs_url: e.Link,
        source_name: 'public-api-lists',
      }));
  } catch (err) {
    console.error('[fetchPublicApiLists]', err);
    return [];
  }
}

export async function fetchPaidApis(): Promise<PaidApiEntry[]> {
  const headers = githubHeaders();

  const searchRes = await fetch(
    `${GITHUB_API_BASE}/search/repositories?q=topic:api+stars:>=50&sort=stars&order=desc&per_page=30`,
    { headers, signal: AbortSignal.timeout(10000) },
  );
  if (!searchRes.ok) throw new Error(`GitHub search failed: ${searchRes.status}`);

  const searchData = await searchRes.json() as {
    items?: Array<{
      html_url: string;
      name: string;
      full_name: string;
      owner: { login: string };
    }>;
  };

  const results: PaidApiEntry[] = [];

  for (const repo of searchData.items ?? []) {
    let ownerEmail: string | null = null;
    let ownerX: string | null = null;

    const userRes = await fetch(`${GITHUB_API_BASE}/users/${repo.owner.login}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (userRes.ok) {
      const userData = await userRes.json() as {
        email?: string | null;
        twitter_username?: string | null;
      };
      ownerEmail = userData.email ?? null;
      ownerX = userData.twitter_username ?? null;
    }

    if (!ownerX) {
      const readmeRes = await fetch(`${GITHUB_API_BASE}/repos/${repo.full_name}/readme`, {
        headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
        signal: AbortSignal.timeout(10000),
      });
      if (readmeRes.ok) {
        const text = await readmeRes.text();
        const xMatch = text.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})/i);
        if (xMatch) ownerX = xMatch[1];
      }
    }

    results.push({
      repo_url: repo.html_url,
      api_name: repo.name,
      owner_github: repo.owner.login,
      owner_email: ownerEmail,
      owner_x: ownerX,
    });
  }

  return results;
}
