export const DISCOVERY_SOURCE_IDS = ['apis_guru', 'public_api_lists', 'github_public_apis', 'public_apis_dev', 'apify_store',
  'rapidapi', 'postman', 'zyla', 'apilayer', 'api_market', 'allthingsdev', 'apyhub', 'apis_io', 'api_tracker', 'api_directory'] as const
export type DiscoverySourceId = typeof DISCOVERY_SOURCE_IDS[number]
export type SourceReadiness = 'ACTIVE-READY' | 'PERMISSION-GATED' | 'CREDENTIAL-GATED' | 'UNSUPPORTED'
export type SourceRegistration = { id: DiscoverySourceId; name: string; status: SourceReadiness; catalogUrl?: string; evidence: string; requirement: string }

/** Access gates are explicit code configuration; credentials alone never activate a source. */
export const discoverySourceCatalog: readonly SourceRegistration[] = [
  { id: 'apis_guru', name: 'APIs.guru', status: 'ACTIVE-READY', catalogUrl: 'https://api.apis.guru/v2/providers.json', evidence: 'https://github.com/APIs-guru/openapi-directory', requirement: 'Public REST catalog; existing verification remains mandatory.' },
  { id: 'public_api_lists', name: 'Public API Lists', status: 'ACTIVE-READY', catalogUrl: 'https://public-api-lists.github.io/public-api-lists/api/all.json', evidence: 'https://github.com/public-api-lists/public-api-lists', requirement: 'MIT notice retained.' },
  { id: 'github_public_apis', name: 'GitHub Public APIs', status: 'ACTIVE-READY', catalogUrl: 'https://raw.githubusercontent.com/public-apis/public-apis/master/README.md', evidence: 'https://github.com/public-apis/public-apis/blob/master/LICENSE', requirement: 'MIT notice retained; directory links are assertions.' },
  { id: 'public_apis_dev', name: 'Public APIs (publicapis.dev)', status: 'ACTIVE-READY', catalogUrl: 'https://raw.githubusercontent.com/marcelscruz/public-apis/master/README.md', evidence: 'https://publicapis.dev/terms', requirement: 'Use the MIT repository, never crawl website listings.' },
  { id: 'apify_store', name: 'Apify Store', status: 'ACTIVE-READY', catalogUrl: 'https://api.apify.com/v2/store', evidence: 'https://docs.apify.com/api/v2/store', requirement: 'Unauthenticated catalog/public-profile GETs only. Never run, rent or subscribe to Actors.' },
  { id: 'rapidapi', name: 'RapidAPI', status: 'PERMISSION-GATED', evidence: 'https://docs.rapidapi.com/docs/getting-started-with-the-graphql-platform-api', requirement: 'Authorized Enterprise Hub Platform API tenant, key and catalog scope, plus reuse permission. Never use private Hub endpoints or product execution as discovery.' },
  { id: 'postman', name: 'Postman API Network', status: 'CREDENTIAL-GATED', evidence: 'https://learning.postman.com/docs/reference/postman-api/intro-api/', requirement: 'API key, approved public workspace/collection scope and reuse rights. Organization API Catalog discovery-services is not a global Public Network export.' },
  { id: 'zyla', name: 'Zyla API Hub', status: 'PERMISSION-GATED', evidence: 'https://creators.zylalabs.com/agents/setup', requirement: 'Commercial catalog-reuse clearance and authorized MCP discovery-only access for browse_catalog/search_catalog/get_api_info. Never register, subscribe or call_api.' },
  { id: 'apilayer', name: 'APILayer Marketplace', status: 'PERMISSION-GATED', evidence: 'https://www.ideracorp.com/Legal/Terms-of-Use', requirement: 'Written automation/commercial reuse permission and a supported catalog feed/export. Website terms restrict automated extraction; product API keys do not grant catalog access.' },
  { id: 'api_market', name: 'API.market', status: 'PERMISSION-GATED', evidence: 'https://api.market/mcp', requirement: 'Written commercial catalog-reuse clearance under the published terms, authorized OAuth or x-api-market-key, and a catalog-only schema/rate/cost contract. Never invoke execution or subscription tools.' },
  { id: 'allthingsdev', name: 'AllThingsDev', status: 'UNSUPPORTED', evidence: 'https://www.allthingsdev.co/documentation/getting-started', requirement: 'Supply a documented automated catalog API or reusable export and applicable permission. Public web browsing and API subscriptions do not establish that interface.' },
  { id: 'apyhub', name: 'ApyHub', status: 'PERMISSION-GATED', evidence: 'https://apyhub.com/terms', requirement: 'Approved catalog-only feed/API and commercial reuse rights. apy-token and curated execution MCP access are not a global provider-catalog export.' },
  { id: 'apis_io', name: 'APIs.io', status: 'PERMISSION-GATED', evidence: 'https://apis.io/terms', requirement: 'Written intended-use clearance under the substantial-replication restriction. Keyless Explore GET /api/v1/providers and /search exist; published tier/rate limits still apply.' },
  { id: 'api_tracker', name: 'API Tracker', status: 'PERMISSION-GATED', evidence: 'https://apitracker.io/', requirement: 'Reusable provider feed/export with documented pagination, rate limits and commercial licensing. Advertised llms.txt agent view does not establish full-catalog reuse rights.' },
  { id: 'api_directory', name: 'APIDirectory', status: 'PERMISSION-GATED', evidence: 'https://apidirectory.com/data', requirement: 'Licensed commercial use and an authorized dataset key for /v1 search/export or MCP. Free evaluation keys and 200-row samples do not license this commercial integration.' },
]

export function sourceCatalogUrl(id: DiscoverySourceId): string {
  const source = discoverySourceCatalog.find(source => source.id === id)
  if (!source?.catalogUrl || source.status !== 'ACTIVE-READY') throw new Error('discovery_source_not_authorized')
  return source.catalogUrl
}
