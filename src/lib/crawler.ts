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
  owner_github: string | null;
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

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type GithubRepo = {
  html_url: string;
  name: string;
  full_name: string;
  description: string | null;
  pushed_at: string;
  topics: string[];
};

const SEARCH_URLS = [
  `${GITHUB_API_BASE}/search/repositories?q=api+server+stars:>100+language:javascript+topic:api&sort=stars&per_page=50`,
  `${GITHUB_API_BASE}/search/repositories?q=api+server+stars:>100+language:python+topic:api&sort=stars&per_page=50`,
  `${GITHUB_API_BASE}/search/repositories?q=rest+api+server+stars:>100+language:go+topic:api&sort=stars&per_page=50`,
  `${GITHUB_API_BASE}/search/repositories?q=free+api+server+stars:>100&sort=stars&per_page=50`,
];

const REPO_NAME_SKIP = [
  'awesome', 'list', 'collection', 'wrapper', 'sdk', 'client', 'lib', 'library',
  'parser', 'generator', 'mock', 'test', 'tutorial', 'example', 'demo',
  'template', 'boilerplate', 'starter', 'docs', 'dotnet', 'java', 'android', 'ios',
];

function isRepoRelevant(repo: GithubRepo): boolean {
  const name = repo.name.toLowerCase();
  if (REPO_NAME_SKIP.some(t => name.includes(t))) return false;
  return true;
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
    const headingMatch = line.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      currentCategory = headingMatch[1].trim();
      continue;
    }

    if (!line.startsWith('|')) continue;
    if (/\|[-\s]+\|/.test(line)) continue;
    if (/\|\s*API\s*\|/i.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 5) continue;

    const [nameCell, description, rawAuth, httpsCell, corsCell] = cells;
    const linkMatch = nameCell?.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!linkMatch) continue;
    if (!/yes/i.test(httpsCell ?? '')) continue;

    results.push({
      name: linkMatch[1],
      description: description ?? '',
      auth: (rawAuth ?? '').replace(/`/g, '').trim(),
      https: true,
      cors: (corsCell ?? '').replace(/`/g, '').trim(),
      link: linkMatch[2],
      category: currentCategory,
      api_docs_url: linkMatch[2],
      source_name: 'public-apis',
    });
  }

  return results;
}

export async function fetchQualityFreeApis(): Promise<PublicApiEntry[]> {
  const headers = githubHeaders();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);

  const reposSeen = new Set<string>();
  const allRepos: GithubRepo[] = [];

  for (let i = 0; i < SEARCH_URLS.length; i++) {
    if (i > 0) await delay(2000);

    const res = await fetch(SEARCH_URLS[i], { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) continue;

    const data = await res.json() as { items?: GithubRepo[] };
    for (const repo of data.items ?? []) {
      if (!reposSeen.has(repo.full_name)) {
        reposSeen.add(repo.full_name);
        allRepos.push(repo);
      }
    }
  }

  const endpointSeen = new Set<string>();
  const results: PublicApiEntry[] = [];

  for (const repo of allRepos) {
    if (!repo.description?.trim()) continue;
    if (new Date(repo.pushed_at) < cutoff) continue;
    if (!isRepoRelevant(repo)) continue;

    const readmeRes = await fetch(`${GITHUB_API_BASE}/repos/${repo.full_name}/readme`, {
      headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
      signal: AbortSignal.timeout(10000),
    });
    await delay(1000);

    if (!readmeRes.ok) continue;

    const text = await readmeRes.text();
    let endpointUrl: string | null = null;

    const SKIP_HOSTS = [
      'star-history.com', 'sonarcloud.io', 'shields.io', 'discord',
      'localhost', '127.0.0.1', 'github.com', 'githubusercontent.com',
      'npmjs.com', 'pkg.go.dev', 'godoc.org', 'travis-ci', 'circleci',
      'appveyor', 'codecov', 'snyk.io', 'gitter.im', 'twitter.com', 'x.com',
      'gitbook.io', 'readthedocs.io',
    ];
    const SKIP_PATH = ['/docs', '/documentation', '/wiki', '/readme', '/changelog'];
    const SKIP_EXT = ['.svg', '.png', '.jpg', '.gif', '.webp'];

    for (const match of text.matchAll(/https:\/\/[^\s<>"')]+/g)) {
      const raw = match[0];
      try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname.toLowerCase();

        if (SKIP_HOSTS.some(s => host.includes(s))) continue;
        if (raw.toLowerCase().includes('badge')) continue;
        if (SKIP_EXT.some(e => path.endsWith(e))) continue;
        if (SKIP_PATH.some(p => path.includes(p))) continue;

        const hostIsApi = host.startsWith('api.');
        const pathHasApiSegment = path.split('/').includes('api');

        if (hostIsApi || pathHasApiSegment) {
          endpointUrl = raw;
          break;
        }
      } catch {
        // malformed URL, skip
      }
    }

    if (!endpointUrl || endpointSeen.has(endpointUrl)) continue;
    endpointSeen.add(endpointUrl);

    results.push({
      name: repo.name,
      description: repo.description,
      auth: 'No',
      https: true,
      cors: 'Unknown',
      link: endpointUrl,
      category: repo.topics?.[0] ?? 'API',
      api_docs_url: repo.html_url,
      source_name: 'github-quality',
    });
  }

  return results;
}

export async function fetchPaidApis(): Promise<PaidApiEntry[]> {
  try {
    const res = await fetch(PUBLIC_APIS_README_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const markdown = await res.text();

    const candidates: Array<{ name: string; link: string }> = [];

    for (const line of markdown.split(/\r?\n/)) {
      if (!line.startsWith('|')) continue;
      if (/\|[-\s]+\|/.test(line)) continue;
      if (/\|\s*API\s*\|/i.test(line)) continue;

      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length < 5) continue;

      const [nameCell, , rawAuth, httpsCell] = cells;
      const linkMatch = nameCell?.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (!linkMatch) continue;
      if (!/yes/i.test(httpsCell ?? '')) continue;

      const auth = (rawAuth ?? '').replace(/`/g, '').trim();
      if (!auth || auth.toLowerCase() === 'no') continue;

      candidates.push({ name: linkMatch[1], link: linkMatch[2] });
    }

    const headers = githubHeaders();
    const results: PaidApiEntry[] = [];

    for (const entry of candidates) {
      let ownerGithub: string | null = null;
      let ownerEmail: string | null = null;
      let ownerX: string | null = null;

      const searchRes = await fetch(
        `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(entry.name)}+in:name&sort=stars&per_page=1`,
        { headers, signal: AbortSignal.timeout(10000) },
      );
      await delay(1000);

      if (searchRes.ok) {
        const searchData = await searchRes.json() as {
          items?: Array<{
            full_name: string;
            stargazers_count: number;
            owner: { login: string };
          }>;
        };
        const repo = searchData.items?.[0];

        if (repo && repo.stargazers_count > 10) {
          ownerGithub = repo.owner.login;

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
        }
      }

      results.push({
        repo_url: entry.link,
        api_name: entry.name,
        owner_github: ownerGithub,
        owner_email: ownerEmail,
        owner_x: ownerX,
      });
    }

    return results;
  } catch {
    return [];
  }
}
