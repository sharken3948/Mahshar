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
  { id: 'rapidapi', name: 'RapidAPI', status: 'PERMISSION-GATED', evidence: 'https://rapidapi.com/page/terms', requirement: 'Approved catalog export/API access and permission for this use; no internal GraphQL or scraping.' },
  { id: 'postman', name: 'Postman API Network', status: 'CREDENTIAL-GATED', evidence: 'https://learning.postman.com/docs/developer/intro-api/', requirement: 'API key and an approved public workspace/collection scope. Account APIs are not global Network search.' },
  { id: 'zyla', name: 'Zyla API Hub', status: 'PERMISSION-GATED', evidence: 'https://zylalabs.com/terms', requirement: 'Permission for commercial provider discovery and a catalog-only key/scope; MCP execution can auto-subscribe and is forbidden.' },
  { id: 'apilayer', name: 'APILayer Marketplace', status: 'PERMISSION-GATED', evidence: 'https://marketplace.apilayer.com/', requirement: 'Documented, approved catalog export/API; product execution keys do not authorize catalog harvesting.' },
  { id: 'api_market', name: 'API.market', status: 'UNSUPPORTED', evidence: 'https://docs.api.market/', requirement: 'No documented global catalog API verified. Usage and seller-management APIs are not discovery feeds.' },
  { id: 'allthingsdev', name: 'AllThingsDev', status: 'UNSUPPORTED', evidence: 'https://www.allthingsdev.co/documentation/getting-started', requirement: 'No supported programmatic catalog contract verified; do not reverse-engineer website requests.' },
  { id: 'apyhub', name: 'ApyHub', status: 'PERMISSION-GATED', evidence: 'https://apyhub.com/catalog', requirement: 'Approved catalog-only access and reuse terms; utility execution/MCP credentials are not catalog permission.' },
  { id: 'apis_io', name: 'APIs.io', status: 'PERMISSION-GATED', evidence: 'https://apis.io/terms', requirement: 'Written clearance for Mahshar under the substantial-replication restriction; approved plan/key if required.' },
  { id: 'api_tracker', name: 'API Tracker', status: 'PERMISSION-GATED', evidence: 'https://apitracker.io/', requirement: 'Approved reusable profile feed/export and licensing; agent-view advertising is not permission to harvest all profiles.' },
  { id: 'api_directory', name: 'APIDirectory', status: 'PERMISSION-GATED', evidence: 'https://apidirectory.com/data', requirement: 'Commercial-use license and catalog key; free developer/sample access does not cover the full commercial registry.' },
]

export function sourceCatalogUrl(id: DiscoverySourceId): string {
  const source = discoverySourceCatalog.find(source => source.id === id)
  if (!source?.catalogUrl || source.status !== 'ACTIVE-READY') throw new Error('discovery_source_not_authorized')
  return source.catalogUrl
}
