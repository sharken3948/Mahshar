import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Network, safeEndpoint, safeReadUrl, credentialPayload, robotsAllows, retryAfter, AccessError, type Page } from '../../src/lib/free-api-worker/network'
import { classifyTerms, evaluate, functional, responseTerms, documentedSample } from '../../src/lib/free-api-worker/pipeline'
import { catalog, examples, specificationEndpoints, links, policyLinks } from '../../src/lib/free-api-worker/discovery'
import { lead, usable, usableCandidates, summary, digest } from '../../src/lib/free-api-worker/model'
import { safeOutboundFetch } from '../../src/lib/outbound-fetch'

const item = lead({ name: 'Books', description: 'Book search API', docs: 'https://books.example.org/docs', auth: 'none', sources: ['https://catalog.example.org/'] })!
const page = (body: unknown, url = 'https://books.example.org/books'): Page => ({ body: JSON.stringify(body), url, type: 'application/json', status: 200, sha256: 'fixture' })
test('inventory regression: response cache releases old bodies without limiting further requests', async () => {
  let firstRequests = 0
  const network = new Network(async url => {
    if (String(url).endsWith('/robots.txt')) return new Response('', { status: 404 })
    if (String(url).endsWith('/first')) firstRequests++
    return new Response('x'.repeat(3_000_000), { headers: { 'content-type': 'text/plain' } })
  })
  await network.page('https://cache.example.org/first')
  await network.page('https://cache.example.org/first')
  assert.equal(firstRequests, 1)
  for (let i = 0; i < 12; i++) await network.page('https://cache.example.org/document/' + i)
  await network.page('https://cache.example.org/first')
  assert.equal(firstRequests, 2)
})
test('inventory regression: credentialed RPC endpoint catalogues are not executed RPC functionality', () => {
  const catalogue = page({ auth: 'Pass your API key', chains: [{ https: 'https://rpc.example.org/eth?key=<API_KEY>', docs: 'https://rpc.example.org/docs/eth', chainId: 1, status: 'online' }] })
  assert.equal(functional(catalogue, 'Free blockchain RPC service').ok, false)
  assert.equal(functional(page({ jsonrpc: '2.0', id: 1, result: '0x1234' }), 'Free blockchain RPC service').ok, true)
  assert.equal(classifyTerms('API terms. You agree not to resell the Service without authorization.').permission, 'REVIEW_REQUIRED')
  assert.equal(classifyTerms('API terms. You must not resell access to this API service.').permission, 'PROHIBITED')
})
test('inventory regression: service setup, tool definitions and support forums are not functional execution', () => {
  for (const [body, purpose] of [
    [{ hello: 'world' }, 'Continuous integration API'],
    [{ name: 'Compliance API', docs: '/docs', mcp: '/mcp' }, 'Compliance data API'],
    [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }, 'Search API'],
    [{ operations: [{ method: 'GET' }], 'x-mcp-tools': [] }, 'PDF form processing'],
    [{ noProviderCalls: true, executionBootstrap: { mode: 'payment' } }, 'DeFi intelligence'],
    [{ users: [], topic_list: { topics: [{ title: 'API support' }] } }, 'Project management API'],
    [{ data: { marketStatus: 1 } }, 'Cryptocurrency exchange'],
    [{ updated: '2026-10-27', ipv4: ['1.1.1.1'], ipv6: [] }, 'Website screenshots'],
    [{ regions: [{ apiUrl: 'https://email.example.org', code: 'eu' }] }, 'Email API'],
  ] as const) assert.equal(functional(page(body), purpose).ok, false, purpose)
  assert.equal(functional(page({ users: [], topic_list: { topics: [{ title: 'Discussion' }] } }), 'Discourse forum API').ok, true)
  assert.equal(functional(page({ data: [{ symbol: 'BTC', price: 123 }] }), 'Cryptocurrency exchange').ok, true)
})
test('438-candidate regression: scripts are not links; explicit response legal notices are terms evidence', () => {
  const doc={...page({}),body:'<script>x](async(foo)); y.href="e";</script><a href="/terms">Terms</a>'}
  assert.deepEqual(links(doc),['https://books.example.org/terms'])
  const commercial={...doc,url:'https://commercial-data.example.org/',type:'text/html',body:'<a href="/font.woff">font</a><a href="/license-plates">plates</a><a href="/terms">terms</a><a href="/terms&quot;">escaped sample</a>'}
  assert.deepEqual(policyLinks(commercial),['https://commercial-data.example.org/terms'])
  const notice=page([{last_updated:123,legal:'You must not resell API access.'},{title:'Example job'}])
  assert.equal(classifyTerms(responseTerms(notice)).permission,'PROHIBITED')
  assert.equal(responseTerms(page([{quote:'Commercial resale is prohibited.'}])),'')
  assert.equal(classifyTerms(responseTerms(page({license:'CC-BY-NC-4.0',data:[1]}))).permission,'PROHIBITED')
  assert.equal(classifyTerms(responseTerms(page({license:'CC-BY-4.0',data:[1]}))).permission,'UNKNOWN')
  assert.equal(classifyTerms('API terms. You may not bypass, share, resell, or use a credential outside its authorized scope.').permission,'UNKNOWN')
  assert.equal(classifyTerms('This work is licensed under a Creative Commons Attribution-NonCommercial 2.5 License.').permission,'PROHIBITED')
  assert.equal(classifyTerms('This work is licensed under a <a>Creative Commons Attribution-NonCommercial 2.5 License</a>.').permission,'PROHIBITED')
  assert.equal(classifyTerms('Permission is granted to use this API commercially and resell proxy access.').permission,'ALLOWED')
  assert.equal(classifyTerms('You may use this API commercially and resell access; contact us if the data contains errors.').permission,'ALLOWED')
  assert.equal(safeReadUrl('https://books.example.org/books?client_id=another-app'),false)
  assert.equal(classifyTerms('The API is made available only for academic use by academic users.').permission,'PROHIBITED')
  assert.equal(classifyTerms('Service terms: a user may only assign rights with prior consent under the German Commercial Code.').permission,'UNKNOWN')
  assert.equal(functional({...page({}),type:'text/csv',body:'name,optional,description\nExample,,"quoted, value"\nSecond,,"two\nlines"'}).ok,true)
  assert.equal(functional({...page({}),type:'text/csv',body:'name,value\nExample,"unterminated'}).ok,false)
})
test('438-candidate regression: short and prefixed server passwords are never persisted', async () => {
  for (const payload of [{ Servers: [{ password: '1234' }] }, { data: { servers: { one: { ssh_password: 'fixture-secret' } } } }]) {
    assert.equal(credentialPayload(JSON.stringify(payload)), true)
    const recorded: string[] = []
    const network = new Network(async url => String(url).endsWith('/robots.txt') ? new Response('', { status: 404 }) : Response.json(payload), {}, () => {}, recordedPage => { recorded.push(recordedPage.url) })
    await assert.rejects(network.page('https://books.example.org/servers'), /credential_payload_rejected/)
    assert.deepEqual(recorded, ['https://books.example.org/robots.txt'])
  }
  assert.equal(credentialPayload(JSON.stringify({ password: false, ssh_password: null })), false)
})
test('438-candidate regression: GET deck creation, drawing and shuffling are mutations', () => {
  for (const path of ['/api/deck/new/shuffle/?deck_count=1','/api/deck/example/draw/?count=2','/api/deck/example/shuffle/']) {
    assert.equal(safeReadUrl('https://cards.example.org'+path),false)
  }
  assert.equal(safeReadUrl('https://cards.example.org/api/deck/example/'),true)
})
test('438-candidate regression: contracts, endpoint directories and paid samples are not data', () => {
  for (const data of [
    { requestSchema: {}, methods: ['GET','POST'], endpoint: '/calculate', output: { description: 'Result schema' } },
    { tools: [{ endpoint: '/cost', params: {} }], openapi: '/openapi.json', usage: 'GET tools' },
    { methods: { GET: {} }, requestFormat: {}, responseFormat: {}, description: 'QR generation' },
    { feeds: { feed: '/data/feed.json' }, docs: '/docs', note: 'Read feeds' },
    { service: 'Example', mcp_tool: 'ask', endpoint: '/ask', params: ['q'] },
    { authenticated: false, principal: null, plan: { name: 'free', maxSites: 25 } },
    { sample_only: true, live_prediction_data_requires_paid_key: true, supported_sports: ['football'] },
    [{ type: 'GET', name: 'Characters', path: '/characters', fullUrl: 'https://books.example.org/characters' }],
    { documentation: 'https://catalog.example.org', methods: 4, health: 90, title: 'API catalogue' },
    "These aren't the droids you're looking for...",
  ]) assert.equal(functional(page(data), 'Character data API').ok,false)
  assert.equal(functional(page({ ad: 'An advert', iseven: true }), 'Is Even API').ok,true)
  assert.equal(functional(page('A real quotation'), 'Quotes API').ok,true)
  assert.equal(functional(page({rows:[{gpu:'Example',price_usd_per_hour:1}]}), 'Example API Suite provides pricing and validation tools.').ok,true)
  assert.equal(functional(page({robots_txt_census:{sites:30}}), 'AI Visibility Checker Checks websites, generates and validates llms.txt.').ok,true)
  assert.equal(safeEndpoint('https://books.example.org/data/index.json'),true)
  assert.equal(functional(page({forecasts:[{temperature:22}]} ,'https://books.example.org/data/index.json')).ok,true)
  assert.equal(functional({...page({}),type:'image/png',binary:{bytes:100,prefix:'89504e470d0a1a0a'}},'Homepage Screenshot API').ok,true)
})
function fixture(pages: Record<string, Response | (() => Response)>) {
  const requests: string[] = []
  const network = new Network(async input => {
    const url = String(input); requests.push(url)
    if (new URL(url).pathname === '/robots.txt' && !(url in pages)) return new Response('', { status: 404 })
    const response = pages[url]
    return typeof response === 'function' ? response() : response ?? new Response('', { status: 404 })
  })
  return { network, requests }
}
test('HTTP 200 is insufficient; reject errors, empty values, health and pricing', () => {
  for (const body of [{ error: 'Missing key' }, { success: false, data: [1] }, { status: 'failed', data: [1] },
    { message: 'API key required' }, { status: false, creator: 'Provider', result: [] }, { count: 0, results: [] },
    { detail: 'Not found', creator: 'Provider' }, { errors: { query: 'Missing' }, creator: 'Provider' },
    { status: 'ok', uptime: 22 }, { plan: 'free', credits: 22 }, {}, [], { results: [] }]) {
    assert.equal(functional(page(body)).ok, false, JSON.stringify(body))
  }
  assert.equal(functional(page({ facts: ['A documented fact'] })).ok, true)
})
test('advertised validation needs a real verdict, including a legitimate negative result', () => {
  assert.equal(functional(page({ status: true, result: [{ title: 'Ringtone', url: 'https://example.org/audio' }] }), 'Text Validation API').ok,false)
  assert.equal(functional(page({ valid: false, iban: 'Invalid public example' }), 'IBAN Validation API').ok,true)
  assert.equal(functional(page({ error: 'API key required', valid: true }), 'IBAN Validation API').ok,false)
})
test('GET write/token paths are blocked even when a catalogue calls them documentation', async () => {
  const { network,requests } = fixture({})
  for (const url of ['https://books.example.org/set/scientist/example','https://books.example.org/tokenizer/token/1','https://books.example.org/books?save=true']) {
    assert.equal(safeReadUrl(url),false); assert.equal(safeEndpoint(url),false)
    await assert.rejects(network.page(url),/unsafe_url/)
  }
  assert.deepEqual(requests,[])
  assert.equal(safeEndpoint('https://books.example.org/get/scientist'),true)
  assert.equal(safeEndpoint('https://books.example.org/tokens/public-asset'),true)
  assert.equal(safeEndpoint('https://opendatadocs.example.org/changelog/feed.json'),false)
  assert.equal(safeEndpoint('https://books.example.org/agents/connections.json'),false)
})
test('credential generation is not requested; credential responses are rejected before persistence', async () => {
  const generated = { ...item, description: 'Generates real WireGuard configurations for Cloudflare WARP' }
  const { network,requests } = fixture({})
  assert.equal((await evaluate(generated,network)).reason,'credential_generation_not_tested'); assert.deepEqual(requests,[])
  assert.equal((await evaluate({ ...item,name:'WARP account generator',description:'Public configuration utility' },network)).reason,'credential_generation_not_tested')
  assert.deepEqual(requests,[])
  let saved = 0
  const transport = new Network(async input => new URL(input).pathname === '/robots.txt' ? new Response('',{status:404})
    : Response.json({ private_key: 'TEST_CREDENTIAL_VALUE_ONLY' }),{},undefined,() => { saved++ })
  await assert.rejects(transport.page('https://books.example.org/data',true),/credential_payload_rejected/)
  assert.equal(saved,1) // robots only; no credential response is persisted
  assert.equal(credentialPayload(JSON.stringify({ token_id: 'public-nft', authorization: { type: 'schema' } })),false)
  assert.equal(credentialPayload(JSON.stringify({ config: '[Interface]\nPrivateKey = ' + 'A'.repeat(43) + '=' })),true)
  assert.equal(functional(page({ access_token: 'TEST_CREDENTIAL_VALUE_ONLY' })).ok,false)
  assert.equal(credentialPayload(JSON.stringify({ $token:'TEST_CREDENTIAL_VALUE_ONLY' })),true)
  assert.equal(credentialPayload(JSON.stringify({ _private_key:'TEST_CREDENTIAL_VALUE_ONLY' })),true)
})
test('explicit client wrappers cannot become API services by calling an API shown in their README', async () => {
  const wrapper={...item,name:'Channel client',description:'A small Swift client wrapper that talks to JSON endpoints'}
  assert.equal(lead(wrapper),null)
  const {network,requests}=fixture({})
  assert.equal((await evaluate(wrapper,network)).reason,'not_an_api_service')
  assert.deepEqual(requests,[])
})
test('regression: Dog CEO uses message for actual service data', () => {
  assert.equal(functional(page({ message: { hound: ['afghan'] }, status: 'success' })).ok, true)
  assert.equal(functional(page({ message: 'https://images.dog.ceo/breeds/hound/test.jpg', status: 'success' })).ok, true)
  assert.equal(functional(page({ message: 'OK', status: 'success' })).ok, false)
  assert.equal(functional({ ...page({ image: 'https://randomfox.ca/images/12.jpg', link: 'https://randomfox.ca/?i=12' }), url: 'https://randomfox.ca/floof/' }).ok, true)
})
test('registry envelopes and engine benchmarks cannot prove the advertised data/calculation function', () => {
  assert.equal(functional(page({ data: { title:'Company API',version:'1',documentation:{openapi:'/spec'},authentication:'none',datasets:[{name:'companies'}] } }), 'Company profiles').ok,false)
  assert.equal(functional(page({ name:'Tools',endpoints:{call:'/call'},tools:[{name:'time',parameters:{}}] }), 'Time calculation').ok,false)
  assert.equal(functional(page({service:'Astrology',free_endpoints:['GET /catalog','GET /health'],payment:{protocols:['x402']},calls:[{route:'POST /positions'}]}),'Natal chart calculation').ok,false)
  for(const body of [
    {api:'Bikes',version:'1',docs:'/docs',openapi:'/openapi.json',endpoints:['/bikes'],licence:'Open data'},
    {name:'Procurement',docs:'/docs',endpoints:['/notices'],mcp_tools:['search'],regime:'free'},
    {name:'Quotes',docs:'/docs',apiCatalog:{quotes:'/quote'},chains:['Example']},
    {name:'Fake data',description:'Products',totalEndpoints:24,groups:['products']},
    {ok:true,service:'Odds',mail:{enabled:true},billing:{enabled:true},checkout:{enabled:true}},
    {servicos:[{id:'notices',preco:1,pedido:'POST /order'}],creditos:{usd:1},pagamento:{metodo:'checkout'},como:'Purchase credits'},
    {servico:'lookup',gratis:{por_dia:1},ofertas:[{preco:1}],como_comprar:'POST for a paid quote',_links:{lookup:'/lookup'}},
  ]) assert.equal(functional(page(body)).ok,false)
  assert.equal(functional(page({engine:'Astronomy',reference:'Reference engine',method:'comparison',samples:'samples.csv',bodies:{sun:{error:0.1}}}), 'Natal chart calculation').ok,false)
  assert.equal(functional(page({data:{company:'Example',industry:'Manufacturing'}}),'Company profiles').ok,true)
  assert.equal(safeEndpoint('https://books.example.org/v1/capabilities'),false)
  const partners=page({partners:[{name:'Integration partner',url:'https://example.org'}]},'https://books.example.org/api/partners')
  assert.equal(functional(partners,'Public procurement notices').ok,false)
  assert.equal(functional(partners,'Public directory of partners').ok,true)
  assert.equal(functional(page({plans:[{name:'Pro',price:1}]},'https://books.example.org/api/plans'),'Public procurement notices').ok,false)
  for(const path of ['/sendMessage','/sendEmail','/setValue','/deleteRecord','/transferFunds']) {
    assert.equal(safeReadUrl('https://books.example.org'+path),false)
  }
})
test('service schemas, model availability and request echoes do not prove the advertised functionality', () => {
  assert.equal(functional(page({ status: 'ok', model: { fact_table: 'finance', dimensions: {}, measures: {} } }), 'Municipal Finance API').ok, false)
  assert.equal(functional(page({ status: 'ok', data: [{ name: 'finance', label: 'Financial data', description: 'Money', uri: 'https://books.example.org/cubes/finance' }] }), 'Municipal Finance API').ok, false)
  assert.equal(functional(page({ object: 'list', data: [{ object: 'model', id: 'language-model' }] }), 'AI text generation proxy').ok, false)
  assert.equal(functional(page({ method: 'get', headers: { accept: 'json' }, url: 'https://example.org' }), 'Page rendering API').ok, false)
  assert.equal(functional(page({ method: 'get', headers: { accept: 'json' }, url: 'https://example.org' }), 'HTTPBin echo').ok, true)
  assert.equal(functional(page({ result: { items: [{ distribution: ['https://example.org'], description: 'Unrelated dataset' }] } }), 'Fuel price API').ok, false)
  assert.equal(functional(page({ data: { collections: [{ collectionId: '1', name: 'Data catalogue' }] } }), 'Realtime Weather API').ok, false)
  assert.equal(functional(page({ result: 'What is your favourite animal?', creator: 'Provider', status: true }), 'Beverage mixing recommendations').ok, false)
  assert.equal(functional(page({ result: 'What is your favourite animal?', creator: 'Provider', status: true }), 'Truth or dare').ok, true)
})
test('a named resource precedes unrelated examples on a multi-service provider page', async () => {
  const api = { ...item, name: 'Books IP API' }
  const { network } = fixture({ [item.docs]: new Response('GET https://books.example.org/api/qr?text=example\nGET https://books.example.org/api/ip/8.8.8.8'),
    'https://books.example.org/api/ip/8.8.8.8': Response.json({ ip: '8.8.8.8', country: 'US' }) })
  assert.equal((await evaluate(api,network)).endpoint, 'https://books.example.org/api/ip/8.8.8.8')
})
test('a root service directory does not hide explicitly documented OpenAPI alternatives', async () => {
  const root={...item,docs:'https://books.example.org/'}
  const {network,requests}=fixture({
    [root.docs]:()=>Response.json({name:'Books',version:'1',documentation:'https://books.example.org/openapi.json',endpoints:{openapi:'/openapi.json'},tools:[]}),
    'https://books.example.org/openapi.json':Response.json({openapi:'3.0.3',paths:{'/books':{get:{responses:{'200':{description:'Books'}}}}}}),
    'https://books.example.org/books':Response.json({books:[{title:'Example'}]}),
  })
  assert.equal((await evaluate(root,network)).endpoint,'https://books.example.org/books')
  assert.ok(requests.includes('https://books.example.org/openapi.json'))
})
test('regression: a documented API may deliver JSON with a JavaScript/plain MIME type', () => {
  for (const type of ['text/javascript', 'application/javascript', 'text/plain']) {
    assert.equal(functional({ ...page({ resultCount: 1, results: [{ artistName: 'Example' }] }), type }).ok, true)
    assert.equal(functional({ ...page({ error: 'Missing credentials' }), type }).ok, false)
  }
  assert.equal(functional({ ...page({ books: ['Example'] }), type: 'text/html' }).ok, false)
})
test('catalogue-linked direct data endpoints support images, CSV and plain phrases; prose documentation is not proof', async () => {
  const direct = { ...item, docs: 'https://books.example.org/direct', name: 'Public Image API' }
  const image = () => new Response(Buffer.from('89504e470d0a1a0a' + '00'.repeat(40),'hex'), { headers: { 'content-type': 'image/png' } })
  assert.equal((await evaluate(direct, fixture({ [direct.docs]: image }).network)).technical, 'PASSED')
  const csv = { ...direct, name: 'Public dataset API' }
  assert.equal((await evaluate(csv, fixture({ [csv.docs]: () => new Response('name,value\nExample,42', { headers: { 'content-type': 'text/csv' } }) }).network)).technical, 'PASSED')
  const phrase = { ...direct, name: 'Tech phrases API', description: 'Random technology phrases' }
  assert.equal((await evaluate(phrase,fixture({ [direct.docs]: () => new Response('Random technology phrase',{ headers: { 'content-type': 'text/plain' } }) }).network)).technical,'PASSED')
  const docs = { ...phrase, docs: 'https://books.example.org/docs' }
  assert.notEqual((await evaluate(docs,fixture({ [docs.docs]: new Response('API documentation: GET https://books.example.org/missing') }).network)).technical,'PASSED')
})
test('Swagger initializer and extensionless config resolve a real anonymous GET, never schema proof', async () => {
  const { network } = fixture({
    [item.docs]: new Response('<script src="/swagger-ui/swagger-initializer.js"></script>', { headers: { 'content-type': 'text/html' } }),
    'https://books.example.org/swagger-ui/swagger-initializer.js': new Response('SwaggerUIBundle({configUrl: "/v3/api-docs/swagger-config"})'),
    'https://books.example.org/v3/api-docs/swagger-config': Response.json({ url: '/v3/api-docs' }),
    'https://books.example.org/v3/api-docs': Response.json({ openapi: '3.0.0', paths: { '/books': { get: { security: [{}, { apiKey: [] }], responses: { '200': { description: 'Books' } } } } } }),
    'https://books.example.org/books': Response.json({ books: ['Working'] }),
  })
  const result = await evaluate(item,network)
  assert.equal(result.endpoint, 'https://books.example.org/books')
  assert.equal(result.technical,'PASSED')
  assert.ok(!result.tests.some(test => /\.js|api-docs/.test(test.url) && test.reason === 'functional_documented_data'))
})
test('service manifests and MCP descriptors are not functional API data', () => {
  assert.equal(functional({ ...page({ name: 'Book API', description: 'Book service', version: '1.0' }), url: 'https://books.example.org/' }).ok, false)
  for (const body of [{ openapi: '3.0.0', paths: {} }, { jsonrpc: '2.0', result: { capabilities: {} } },
    { tools: [{ name: 'search', inputSchema: {} }] }, { endpoints: ['/books'], version: 1 }]) assert.equal(functional(page(body)).ok, false)
  assert.equal(functional(page({ tools: [{ name: 'Editor', monthlyPrice: 20, features: ['Editing'] }] })).ok, true)
  assert.equal(functional(page({ currency: 'LKR', netSalary: 180975, openapi: 'https://salary.example/openapi.json' })).ok, true)
  assert.equal(functional(page({ name: 'App', icons: [{ src: '/icon.png' }] })).ok, false)
  assert.equal(functional(page({ apis: [{ name: 'Data', baseURL: '/' }], specificationVersion: '0.19' })).ok, false)
  assert.equal(safeEndpoint('https://books.example.org/icons/manifest.json'), false)
  assert.equal(safeEndpoint('https://books.example.org/apis.json'), false)
  assert.equal(functional(page({ books: 'https://books.example.org/books' })).ok, false)
  assert.equal(functional(page({ weather: { version: '1', documentation: 'https://books.example.org/docs' } })).ok, false)
  assert.equal(functional(page({ transport: 'JSON-RPC POST', mcp: 'https://books.example.org/mcp', chains: [{ endpoint: 'https://books.example.org/rpc' }] })).ok, false)
  assert.equal(safeEndpoint('https://books.example.org/.well-known/agent.json'), false)
  assert.equal(safeEndpoint('https://books.example.org/tool-schema.json'), false)
  assert.equal(safeEndpoint('https://books.example.org/api/config-sdk'), false)
  assert.equal(safeEndpoint('https://books.example.org/developers/access.json'), false)
  assert.equal(safeEndpoint('https://books.example.org{path-to-image/'), false)
  assert.equal(safeEndpoint('https://cards.example.org/skill.json'), true)
  assert.equal(functional(page([{ name: 'Example game skill', effect: 'Draw a card' }])).ok, true)
  assert.equal(functional(page({ info: { _postman_id: 'fixture' }, item: [{ request: { method: 'GET' } }] })).ok, false)
  assert.equal(functional(page({ versions: ['0.2'], identifierSpace: '/id/', schemaSpace: '/schema/', suggest: { entity: '/suggest' } })).ok, false)
})
test('documented base paths and JSON hyperlinks retain public parameters', () => {
  const doc = { ...page({}), type: 'text/html', url: item.docs,
    body: 'Base URL: https://books.example.org/v1\nGET /books?language=en\n<a href="/v1/all.json">JSON data</a>' }
  assert.deepEqual(examples(doc, item), ['https://books.example.org/v1/books?language=en', 'https://books.example.org/v1/all.json'])
})
test('navigation and bare website URLs cannot validate a different API product', () => {
  const doc = { ...page({}), type: 'text/html', url: item.docs, body: 'Related services: https://books.example.org/geocoding\nGET https://books.example.org/books' }
  assert.deepEqual(examples(doc, item), ['https://books.example.org/books'])
  assert.equal(safeEndpoint('https://books.example.org/mcp'), false)
  assert.equal(safeEndpoint('https://books.example.org/books?ids=$IDS'), false)
  const official = { ...item, docs: 'https://musicbrainz.org/doc' }
  assert.deepEqual(examples({ ...doc, url: official.docs, body: 'GET https://openwhyd.org/hot/electro?format=json' }, official), [])
  const wiki = { ...item, docs: 'https://runescape.wiki/w/API' }
  assert.equal(examples({ ...doc, url: wiki.docs, body: 'GET https://secure.runescape.com/data.json' }, wiki).length, 1)
})
test('regression: root and sorted-query examples on a different API host preserve provenance', () => {
  const hosted = { ...item, docs: 'https://github.com/provider/books' }
  const doc = { ...page({}), type: 'text/html', url: hosted.docs,
    body: 'GET\nMagic API\nhttps://public.other.org\nGET https://public.other.org/search?z=1&a=2' }
  assert.deepEqual(examples(doc, hosted), ['https://public.other.org/', 'https://public.other.org/search?a=2&z=1'])
})
test('concrete documented JSON parameters are safe; placeholders and private nested URLs rejected', () => {
  const url = new URL('https://chart.example.org/chart')
  url.searchParams.set('c', JSON.stringify({ type: 'bar', data: { labels: ['A'], datasets: [{ data: [1] }] } }))
  assert.equal(safeEndpoint(url.href), true)
  assert.equal(safeEndpoint('https://books.example.org/books?url=http%3A%2F%2F169.254.169.254%2F'), false)
  assert.equal(safeEndpoint('https://books.example.org/books?q=payments'), true)
  assert.equal(safeEndpoint('https://books.example.org/books?access_key=secret'), false)
  assert.equal(safeEndpoint('https://books.example.org/books?key=secret'), false)
  assert.equal(safeEndpoint('https://books.example.org/books?author=Example&token_id=123'), true)
  assert.equal(safeEndpoint('https://books.example.org/books?X-Amz-Signature=secret'), false)
  assert.deepEqual(examples({ ...page({}), url: item.docs, body: 'GET https://books.example.org/books?ref=123', type: 'text/plain' }, item),
    ['https://books.example.org/books?ref=123'])
})
test('documented image/CSV/plain-text functionality needs actual payload evidence', () => {
  const png = { ...page({}), type: 'image/png', binary: { bytes: 80, prefix: '89504e470d0a1a0a0000000d49484452' } }
  assert.equal(functional(png, 'Chart image API').ok, true)
  assert.equal(functional({ ...png, binary: { bytes: 80, prefix: '000000000000' } }, 'Chart image API').ok, false)
  assert.equal(functional(png, 'Books API').ok, false)
  assert.equal(functional({ ...page({}), type: 'text/csv', body: 'country,value\nExample,10\nOther,20' }).ok, true)
  assert.equal(functional({ ...page({}), type: 'text/csv', body: 'country,value' }).ok, false)
  assert.equal(functional({ ...page({}), type: 'text/plain', body: 'Hello, wonderful world!' }, 'Hello greeting API').ok, true)
  assert.equal(functional({ ...page({}), type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>' }, 'Placeholder image API').ok, true)
  assert.equal(functional({ ...page({}), type: 'image/svg+xml', body: '<svg><script>alert(1)</script><rect/></svg>' }, 'Placeholder image API').ok, false)
})
test('a dataset portal favicon is not proof of a dataset API function', async () => {
  const data = lead({ ...item, name: 'Dataset Portal', description: 'Access charts, datasets and public documents' })!
  const { network } = fixture({ [item.docs]: new Response('GET https://books.example.org/favicon.ico'),
    'https://books.example.org/favicon.ico': new Response(Buffer.from('00000100' + '00'.repeat(60), 'hex'), { headers: { 'content-type': 'image/x-icon' } }) })
  assert.notEqual((await evaluate(data, network)).technical, 'PASSED')
})
test('Swagger/Redoc configuration is followed as documentation, never service proof', async () => {
  const { network, requests } = fixture({
    [item.docs]: new Response('<link href="/swagger.css"><script>fetch("/spec.json")</script>'),
    'https://books.example.org/spec.json': Response.json({ openapi: '3.0.0', servers: [{ url: 'https://books.example.org' }], paths: { '/books': { get: {} } } }),
    'https://books.example.org/books': Response.json({ books: ['A book'] }),
  })
  assert.equal((await evaluate(item, network)).technical, 'PASSED')
  assert.ok(requests.includes('https://books.example.org/spec.json'))
  assert.ok(!requests.includes('https://books.example.org/swagger.css'))
})
test('JSON hypermedia links lead to real data; the directory itself is not proof', async () => {
  const { network } = fixture({ [item.docs]: Response.json({ books: 'https://books.example.org/books' }),
    'https://books.example.org/books': Response.json({ books: [{ title: 'A book' }] }) })
  const result = await evaluate(item, network)
  assert.equal(result.endpoint, 'https://books.example.org/books'); assert.equal(usable(result), true)
})
test('a working image API JSON response stays the endpoint; its static image is not substituted', async () => {
  const fox = lead({ name: 'Random Fox', description: 'Random fox pictures', docs: 'https://books.example.org/random', auth: 'none', sources: [] })!
  const { network } = fixture({ [fox.docs]: () => Response.json({ image: 'https://books.example.org/images/12.jpg', link: 'https://books.example.org/random?id=12' }) })
  assert.equal((await evaluate(fox, network)).endpoint, fox.docs)
})
test('explicit official documentation migration is followed without changing API identity', async () => {
  const { network } = fixture({
    [item.docs]: new Response('This API documentation has moved to https://newdocs.example.net/docs'),
    'https://newdocs.example.net/docs': new Response('GET https://books.example.org/books'),
    'https://books.example.org/books': Response.json({ books: ['A book'] }),
  })
  assert.equal((await evaluate(item, network)).technical, 'PASSED')
})
test('Stop prevents any later HTTP dispatch and leaves a resumable reason', async () => {
  let calls = 0, active = true
  const network = new Network(async url => { calls++; return new URL(url).pathname === '/robots.txt'
    ? new Response('', { status: 404 }) : Response.json({ books: ['A book'] }) }, {}, undefined, undefined, async () => active)
  await network.page('https://books.example.org/books')
  const before = calls; active = false
  await assert.rejects(network.page('https://books.example.org/other'), /worker_stopped/)
  assert.equal(calls, before)
})
test('curated GET service example is accepted when official docs contain no endpoint', async () => {
  const source = 'https://freepublicapis.com/books-test'
  const { network } = fixture({
    [item.docs]: new Response('Books API docs. Use our public catalogue for request examples.'),
    [source]: new Response('GET\nFind books\nhttps://books.example.org/books'),
    'https://books.example.org/books': Response.json({ books: ['A book'] }),
  })
  const result = await evaluate({ ...item, sources: [source] }, network)
  assert.equal(result.technical, 'PASSED'); assert.equal(result.docs, source)
  assert.ok(!result.evidence.some(e => e.url === source))
})
test('an unavailable named API never falls back to an unrelated product in a generic provider document', async () => {
  const source = 'https://freepublicapis.com/books-test'
  const { network, requests } = fixture({ [item.docs]: new Response('GET https://books.example.org/api/game/truth'),
    [source]: new Response('GET https://books.example.org/v1/books'),
    'https://books.example.org/v1/books': new Response('', { status: 404 }),
    'https://books.example.org/api/game/truth': Response.json({ question: 'Unrelated game' }),
  })
  assert.notEqual((await evaluate({ ...item, sources: [source] }, network)).technical, 'PASSED')
  assert.ok(!requests.includes('https://books.example.org/api/game/truth'))
})
test('documented version changes retain safe alternatives within the named API resource', async () => {
  const source = 'https://freepublicapis.com/books-test'
  const { network } = fixture({ [item.docs]: new Response('GET https://books.example.org/v2/books'),
    [source]: new Response('GET https://books.example.org/v1/books'),
    'https://books.example.org/v1/books': new Response('', { status: 404 }),
    'https://books.example.org/v2/books': Response.json({ books: ['Current book'] }),
  })
  assert.equal((await evaluate({ ...item, sources: [source] }, network)).endpoint, 'https://books.example.org/v2/books')
})
test('UNKNOWN is usable after real free functionality; no publication/approval gate', async () => {
  const { network } = fixture({
    [item.docs]: new Response('GET https://books.example.org/books'),
    'https://books.example.org/books': Response.json({ books: [{ title: 'A real book' }] }),
  })
  const result = await evaluate(item, network)
  assert.equal(result.technical, 'PASSED'); assert.equal(result.freeAccess, 'VERIFIED')
  assert.equal(result.permission, 'UNKNOWN'); assert.equal(result.termsChecked, true)
  assert.equal(usable(result), true); assert.ok(result.lastSuccess)
})
test('a direct JSON API still researches the official provider homepage and terms', async () => {
  const direct = { ...item, docs: 'https://books.example.org/books' }
  const result = await evaluate(direct, fixture({
    [direct.docs]: () => Response.json({ books: ['Working book'] }),
    'https://books.example.org/': new Response('<a href="/terms">Terms</a>', { headers: { 'content-type': 'text/html' } }),
    'https://books.example.org/terms': new Response('You must not resell API access.'),
  }).network)
  assert.equal(result.technical,'PASSED'); assert.equal(result.permission,'PROHIBITED'); assert.equal(usable(result),false)
})
test('Stop during terms research leaves a resumable result without a completed terms claim', async () => {
  let permitted = true, dataCalls = 0
  const direct = { ...item, docs: 'https://books.example.org/books' }
  const network = new Network(async input => {
    if (new URL(input).pathname === '/robots.txt') return new Response('', { status: 404 })
    if (++dataCalls === 2) permitted = false
    return Response.json({ books: ['Working'] })
  }, {}, undefined, undefined, async () => permitted)
  const result = await evaluate(direct,network)
  assert.equal(result.technical,'PASSED')
  assert.equal(result.reason,'worker_stopped'); assert.equal(result.termsChecked,false)
  assert.ok(result.retryAt); assert.equal(usable(result),false)
})
test('alternatives continue after nonfunctional HTTP 200', async () => {
  const { network, requests } = fixture({
    [item.docs]: new Response('GET https://books.example.org/books/bad\nGET https://books.example.org/books?title=Example'),
    'https://books.example.org/books/bad': Response.json({ error: 'no data' }),
    'https://books.example.org/books?title=Example': Response.json({ title: 'Example', author: 'Writer' }),
  })
  const result = await evaluate(item, network)
  assert.equal(result.technical, 'PASSED'); assert.match(result.endpoint!, /title=Example/)
  assert.ok(requests.includes('https://books.example.org/books/bad'))
})
test('an endpoint-specific 503 without Retry-After does not starve a healthy documented alternative', async () => {
  const { network } = fixture({ [item.docs]: new Response('GET https://books.example.org/books/bad\nGET https://books.example.org/books'),
    'https://books.example.org/books/bad': new Response('', { status: 503 }),
    'https://books.example.org/books': Response.json({ books: ['Available'] }) })
  assert.equal((await evaluate(item, network)).technical, 'PASSED')
})
test('required unavailable credentials never yield technical success', async () => {
  const { network, requests } = fixture({ [item.docs]: new Response('An API key is required. GET https://books.example.org/books') })
  const result = await evaluate({ ...item, auth: 'required' }, network)
  assert.equal(result.freeAccess, 'CREDENTIALS_REQUIRED'); assert.notEqual(result.technical, 'PASSED')
  assert.ok(!requests.includes('https://books.example.org/books'))
})
test('official required credentials override an unknown catalogue auth label', async () => {
  const { network, requests } = fixture({ [item.docs]: new Response('API key is required. GET https://books.example.org/books') })
  const result = await evaluate({ ...item, auth: 'unknown' }, network)
  assert.equal(result.freeAccess, 'CREDENTIALS_REQUIRED'); assert.notEqual(result.technical, 'PASSED')
  assert.ok(!requests.includes('https://books.example.org/books'))
})
test('PROHIBITED excluded with official evidence retained', async () => {
  const { network } = fixture({
    [item.docs]: new Response('GET https://books.example.org/books\n<a href="/terms">API Terms</a>'),
    'https://books.example.org/books': Response.json({ books: ['A book'] }),
    'https://books.example.org/terms': new Response('You must not resell access to our API service.'),
  })
  const result = await evaluate(item, network)
  assert.equal(result.permission, 'PROHIBITED'); assert.equal(usable(result), false)
  assert.ok(result.evidence.some(e => e.url.endsWith('/terms') && e.note.includes('must not')))
})
test('terms distinguish grants, bans, conflict, conditional permission, SDK licence', () => {
  assert.equal(classifyTerms('Commercial use of this API is allowed. Don’t resell the raw data itself as a standalone product.').permission,'REVIEW_REQUIRED')
  assert.equal(classifyTerms('Do not resell API access.').permission,'PROHIBITED')
  assert.equal(classifyTerms('Commercial proxy access and resale of our API service are explicitly allowed.').permission, 'ALLOWED')
  assert.equal(classifyTerms('You may not resell API access.').permission, 'PROHIBITED')
  assert.equal(classifyTerms('You may not resell API access. Commercial proxy access to our API is allowed.').permission, 'REVIEW_REQUIRED')
  assert.equal(classifyTerms('You may resell API access with written consent.').permission, 'REVIEW_REQUIRED')
  assert.equal(classifyTerms('Our SDK source code is allowed for commercial resale.').permission, 'UNKNOWN')
  assert.equal(classifyTerms('We do not prohibit commercial use of our API.').permission, 'UNKNOWN')
})
test('regression: unrelated negation and inclusive non-commercial wording are not API prohibitions', () => {
  for (const terms of [
    'Browsers should use a local proxy to our API since you cannot store client secrets in Javascript.',
    'The API is free for all personal, non-commercial, or commercial purposes.',
    'The data on this website and our APIs are free for both commercial and non-commercial purposes.',
    "Open API guidance. For example, non-commercial restrictions would prevent commercial use.",
    'The API reports commercial and non-commercial long/short/net exposure.',
    'The service makes a fair proxy since a vote cannot be gated on having played this map.',
    'Commercial lending: the Financial Ombudsman Service may not be available to you.',
    'Using the Service for Commercial AI means you waive policies that would prohibit GitHub access to your data.',
    'API privacy. We do not sell query data to third parties.',
    'API privacy. We never sell data, run third-party advertising, or load third-party scripts on this site.',
    'API privacy. Do Not Sell or Share My Personal Information.',
    'API terms. You may use the site for personal and commercial planning.',
    'API output. You may copy, redistribute and use output for commercial purposes; credit the source and do not imply endorsement.',
  ]) assert.equal(classifyTerms(terms).permission, 'UNKNOWN', terms)
  assert.equal(classifyTerms('Our API is for non-commercial use only.').permission,'PROHIBITED')
  assert.equal(classifyTerms('Do not resell raw access to the API without our written agreement.').permission,'REVIEW_REQUIRED')
  assert.equal(classifyTerms('Do not resell API data without proper attribution.').permission,'REVIEW_REQUIRED')
  assert.equal(classifyTerms('You may not resell our API data as a feed.').permission,'PROHIBITED')
  assert.equal(classifyTerms('API terms. You may not:\nresell, sublicense or redistribute the raw data as a competing API.').permission,'PROHIBITED')
  assert.equal(classifyTerms('Acceptable use of our service. You agree not to:\nAttack systems\nResell or redistribute the Service without our written consent.').permission,'REVIEW_REQUIRED')
  assert.equal(classifyTerms('API terms. Not resell, sublicense, or redistribute the Service without our written permission.').permission,'REVIEW_REQUIRED')
  assert.equal(classifyTerms('API documentation. Information about our products and services on the Site is for personal, non-commercial informational use.').permission,'REVIEW_REQUIRED')
  assert.equal(classifyTerms('Service terms. The User agrees that they will not: put illegal content on the Service; copy, manipulate or aggregate Content to trade, sell, rent or license access to any third party.').permission,'REVIEW_REQUIRED')
})
test('regression: a linked partner review is not a documented API endpoint', () => {
  const doc = { ...page({}), url: item.docs, type: 'text/html', body: '<a href="/partners/source-review.json">Partner source review</a><a href="/api/books.json">JSON data</a>' }
  assert.deepEqual(examples(doc,item),['https://books.example.org/api/books.json'])
})
test('relative code samples and legacy HTTP examples are resolved without plaintext requests', () => {
  const doc = { ...page({}), url: item.docs, type: 'text/html', body: '<pre>GET http://books.example.org/books?title=Example</pre><pre>fetch("<span>/v1/today</span>")</pre>' }
  const urls=examples(doc,item)
  assert.ok(urls.includes('https://books.example.org/books?title=Example'))
  assert.ok(urls.includes('https://books.example.org/v1/today'))
  assert.ok(urls.every(url=>url.startsWith('https://')))
  const configured={...doc,body:'<select id="baseUrl"><option value="https://books.example.org"></option></select><pre>curl -s {base}/api/books</pre>'}
  assert.deepEqual(examples(configured,item),['https://books.example.org/api/books'])
})
test('SSRF, credentials, health and side effects rejected before dispatch', () => {
  for (const url of ['https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://localhost/a', 'https://[::1]/a',
    'http://books.example.org/books', 'https://books.example.org/books?api_key=secret',
    'https://books.example.org/health', 'https://books.example.org/delete/22', 'https://books.example.org/docs',
    'https://books.example.org/books?action=delete', 'https://books.example.org/books/{id}']) assert.equal(safeEndpoint(url), false, url)
})
test('shared pinned transport blocks mixed private DNS before requester', async () => {
  let called = false
  await assert.rejects(safeOutboundFetch('https://books.example.org/books', {}, {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    requester: async () => { called = true; return Response.json({}) },
  }), /blocked_destination/)
  assert.equal(called, false)
})
test('robots longest-match allow and named agent; endpoint policy enforced', async () => {
  const rules = 'User-agent: *\nDisallow: /\nAllow: /books\nDisallow: /books/private$'
  assert.equal(robotsAllows(rules, 'https://books.example.org/books'), true)
  assert.equal(robotsAllows(rules, 'https://books.example.org/books/private'), false)
  const { network, requests } = fixture({
    'https://books.example.org/robots.txt': new Response('User-agent: *\nDisallow: /books'),
  })
  await assert.rejects(network.page('https://books.example.org/books'), /robots_disallowed/)
  assert.deepEqual(requests, ['https://books.example.org/robots.txt'])
})
test('redirects repeat safety and robots checks; cycles terminate', async () => {
  const { network, requests } = fixture({
    'https://books.example.org/books': new Response(null, { status: 302, headers: { location: 'https://second.example.org/books' } }),
    'https://second.example.org/robots.txt': new Response('User-agent: *\nDisallow: /'),
  })
  await assert.rejects(network.page('https://books.example.org/books'), /robots_disallowed/)
  assert.ok(!requests.includes('https://second.example.org/books'))
  const cycle = fixture({
    'https://books.example.org/a': () => new Response(null, { status: 302, headers: { location: '/b' } }),
    'https://books.example.org/b': () => new Response(null, { status: 302, headers: { location: '/a' } }),
  })
  await assert.rejects(cycle.network.page('https://books.example.org/a'), /redirect_cycle/)
  assert.ok(cycle.requests.length < 10)
})
test('real Retry-After pauses a host; other providers continue', async () => {
  const { network, requests } = fixture({
    'https://books.example.org/books': new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    'https://other.example.org/books': Response.json({ title: 'Other' }),
  })
  await assert.rejects(network.page('https://books.example.org/books'), AccessError)
  await assert.rejects(network.page('https://books.example.org/other'), /provider_cooldown/)
  assert.equal((await network.page('https://other.example.org/books')).status, 200)
  assert.equal(requests.filter(url => url === 'https://books.example.org/other').length, 0)
  assert.equal(retryAfter('120', 0), '1970-01-01T00:02:00.000Z')
})
test('a valid HTTP 200 payload with Retry-After is retained while later calls wait', async () => {
  const { network } = fixture({ 'https://books.example.org/books': Response.json({ books: ['Example'] }, { headers: { 'retry-after': '60' } }) })
  assert.equal(functional(await network.page('https://books.example.org/books')).ok, true)
  await assert.rejects(network.page('https://books.example.org/later'), /provider_cooldown/)
})
test('short provider pauses are paced without redispatching or starving a completed robots check', async () => {
  let calls = 0
  const network = new Network(async input => { calls++; return new URL(input).pathname === '/robots.txt'
    ? new Response('', { status: 404 }) : Response.json({ books: ['Example'] }) }, { 'https://books.example.org': new Date(Date.now() + 50).toISOString() })
  assert.equal((await network.page('https://books.example.org/books')).status, 200)
  assert.equal(calls, 2)
})
test('inventory regressions: documentation wrappers, configuration and counters are not functional service data', () => {
  const cases: Array<[unknown, string]> = [
    [{ html: '<pre>API documentation</pre>', raw_path: '/raw/README.md', blame_path: '/blame/README.md' }, 'Sports results'],
    [{ server: { name: 'Books API' }, tools: [{ name: 'get_book', input_schema: { type: 'object' } }] }, 'Books'],
    [{ name: 'Audio API', version: '1', docs: '/docs', openapi: '/openapi.json', mcp: '/mcp' }, 'Audio separation'],
    [{ service: 'Company API', version: '1', description: 'Company lookup', endpoints: { free: '/preview' }, paiement: {} }, 'Company lookup'],
    [{ getCharacter: '/character', getCharacterById: '/character/:id' }, 'Character data'],
    [{ count: 0, total_pages: 0 }, 'Open source contributions'],
    [{ data: [{ id: 'model', input_modalities: ['text'], pricing: { prompt: '0.01' } }] }, 'Text generation'],
    [{ page: { url: 'https://status.example.org' }, status: {}, components: [], incidents: [] }, 'Email delivery'],
    [{ requestMaxBytes: 1000, sites: { maxFiles: 10 }, reach: 'token' }, 'File hosting'],
    [{ languages: [{ name: 'en', file: 'en', title: 'English' }] }, 'Air pollution'],
    [{ data: [{ status: 'planned', title: 'SDK', text: 'Future SDK development' }] }, 'Market analysis'],
    [{ ok: true, data: { site: 'Fonts', fonts: 100, endpoints: { fonts: '/fonts' } } }, 'Download fonts'],
    [{ abi: {}, abiRevision: 1, versions: [{ status: 'pending' }] }, 'DEX quotes'],
    [{ provider: 'Social API', docs: '/docs', billingUnit: { unit: 'call' }, usdPer1000Tweets: { low: 0.1 } }, 'Public social media posts'],
    [{ datasets: [{ title: 'Vehicles', columns: [{ name: 'model' }], formats: { json: '/vehicles.json' } }] }, 'Vehicle complaints'],
    [{ object: 'list', registry_hash: 'hash', release: 'version', data: [{ name: 'Available framework' }] }, 'Text completions'],
    [{ nodes: [{ type: 'n8n-nodes-base.httpRequest' }], connections: {}, name: 'First transcript workflow' }, 'Video transcripts'],
    [{ contractVersion: '1', endpointBase: '/templates', templatePayload: { fields: [] } }, 'PDF generation'],
    [{ capabilities: [{ platform: 'social', action: 'search', required_params: ['keyword'] }] }, 'Social data'],
    [{ apis: [{ method: 'POST', path: '/run', name: 'Post lookup' }] }, 'Scraping APIs'],
    [{ message: 'Welcome', categories: ['general'], endpoints: { random: '/jokes/random' } }, 'Jokes'],
    [{ status: 'ok', service: 'Geolocation', host: 'public.example.org', response_ms: 1 }, 'IP geolocation'],
    [{ name: 'Environment', values: [], _postman_variable_scope: 'environment' }, 'Stablecoin data'],
    [{ transport: 'JSON-RPC', openapi: '/openapi.json', hint: 'Authenticate before POST' }, 'Video generation'],
    [{ podcasts: { totals: [{ count: 100 }] }, episodes: { totals: [{ count: 500 }], added: [{ window: '24h', count: 4 }] } }, 'Podcast transcripts'],
    [{ exchanges: [{ name: 'Exchange', type: 'crypto_exchange', api: 'ccxt' }] }, 'Money transfer routing'],
    [{ domain: 'example.com', dmarc: { grade: 'A' }, spf: { valid: true } }, 'Detect AI-generated text'],
    [{ input: 'hello world', encoded: 'hello%20world', decoded: 'hello world' }, 'Detect AI-generated text'],
    [{ status_code: 124, data: null, error_message: 'Jwt is invalid' }, 'Video meetings'],
    [{ name: 'Assistant', input_schema: { type: 'object' } }, 'AI assistant'],
    [{ name: 'Assistant', inputSchema: { type: 'object' } }, 'AI assistant'],
    [{ function_declarations: [{ name: 'Assistant', parameters: { type: 'object' } }] }, 'AI assistant'],
    [{ meta_tool: { name: 'Assistant', input_schema: { type: 'object' } } }, 'AI assistant'],
    [{ contract: { hierarchy: ['product'], dimensions: { pricing_model: ['usage'] } }, families: [] }, 'Data extraction'],
    [{ runsTotal: 10, cases: 20, runs: [{ passed: 20 }] }, 'Agent teams'],
    [{ billing: {}, types: [{ type: 'operation', required_params: [] }] }, 'External data extraction'],
    [{ tools: [{ name: 'Search' }], how_to_choose: { preferred: 'keyword' }, billing: {} }, 'Search content'],
    [{ results: [{ method: 'POST', path: '/run', pricing: { unit: 'call' } }] }, 'Scraping APIs'],
    [[{ at: '2026-10-27', by: 'builder', kind: 'build', what: 'Added button' }], 'Agent team workflow orchestration'],
  ]
  for (const [body, description] of cases) assert.equal(functional(page(body), description).ok, false, description)
  assert.equal(functional(page({ page: { url: 'https://status.example.org' }, status: {}, components: [{ name: 'API', status: 'operational' }], incidents: [] }), 'Provider status API').ok, true)
  assert.equal(functional(page({ data: [{ title: 'A real book', author: 'An author' }] }), 'Books').ok, true)
  assert.equal(functional(page([17169, 10431333700, 6806], 'https://weather.example.org/stats'), 'Weather station measurements').ok, false)
  assert.equal(safeEndpoint('https://locations.example.org/redis-health'), false)
  assert.equal(functional(page({ status_code: 0, data: { title: 'Meeting' }, error_message: '' }), 'Meetings').ok, true)
  assert.equal(functional(page({ ai_score: 0.7, sentences: [] }), 'Detect AI-generated text').ok, true)
})
test('a documented downloadable example file is not a working API; real JSON endpoints remain eligible', () => {
  const endpoint = 'https://books.example.org/example.json'
  const doc = { ...page({}), body: 'Download example of the history bulk file in <a href="/example.json">JSON</a> format.' }
  assert.equal(documentedSample([doc], endpoint, 'Historical data API'), true)
  assert.equal(documentedSample([doc], endpoint, 'Mock sample data API'), false)
  assert.equal(documentedSample([{ ...doc, body: 'Example request: GET <a href="/example.json">JSON data</a>' }], endpoint, 'Historical data API'), false)
})
test('request example defaults cannot create a commercial prohibition', () => {
  assert.equal(classifyTerms('API data finder. Defaults: volume 0, US, no resale.').permission, 'UNKNOWN')
  assert.equal(classifyTerms('API terms. No resale of API access.').permission, 'PROHIBITED')
  assert.equal(classifyTerms('API terms. Do not resell raw access in violation of these terms.').permission, 'REVIEW_REQUIRED')
})
test('canned detector output does not prove an actual lookup; mock-data services remain functional', () => {
  const sample = page({ sample: true, status: 'success', ip: '198.51.100.18', risk_score: 65 })
  assert.equal(functional(sample, 'Detect VPNs and proxies').ok, false)
  assert.equal(functional(sample, 'Mock IP risk data').ok, true)
  assert.equal(functional(page({ ip: '1.1.1.1', risk_score: 3 }), 'Detect VPNs and proxies').ok, true)
})
test('real endpoint tests request API data rather than negotiating documentation HTML', async () => {
  const network = new Network(async (input, init) => {
    if (new URL(input).pathname === '/robots.txt') return new Response('', { status: 404 })
    const accept = new Headers((init as RequestInit).headers).get('accept') ?? ''
    return accept.includes('text/html') ? new Response('<html>Documentation</html>', { headers: { 'content-type': 'text/html' } }) : Response.json({ books: ['Actual data'] })
  })
  assert.equal((await network.page('https://books.example.org/books')).type, 'text/html')
  assert.equal(functional(await network.page('https://books.example.org/books', true)).ok, true)
})
test('TLS/DNS failures retain sanitized causes without disabling the shared transport policy', async () => {
  const events: Record<string, unknown>[] = []
  const network = new Network(async () => { throw Object.assign(new Error('untrusted details'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }, {}, event => events.push(event))
  await assert.rejects(network.page('https://books.example.org/books'), /tls_failure/)
  assert.equal(events[0].code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  assert.ok(!JSON.stringify(events).includes('untrusted details'))
})
test('no artificial daily/provider quotas: 40 distinct documented GETs all run', async () => {
  let calls = 0
  const network = new Network(async url => new URL(url).pathname === '/robots.txt'
    ? new Response('', { status: 404 }) : (calls++, Response.json({ value: calls })))
  for (let index = 0; index < 40; index++) await network.page(`https://books.example.org/books/${index}`, true)
  assert.equal(calls, 40)
})
test('catalogue excludes tools; identity is stable and URL case retained', () => {
  const body = '| [Books](https://books.example.org/Docs?utm_source=other) | Book search API | No | Yes |\n'
    + '| [Fuzzer](https://fuzz.example.org/) | OpenAPI fuzzer | No | Yes |\n'
    + '| [An SDK](https://sdk.example.org/) | SDK library | No | Yes |'
  const found = catalog(body, 'https://catalog.example.org/')
  assert.equal(found.length, 1); assert.match(found[0].docs, /\/Docs$/)
  assert.equal(found[0].id, item.id)
  assert.ok(lead({ name: 'Public Library', description: 'Search public library books', docs: item.docs, auth: 'none', sources: [] }))
  assert.ok(lead({ name: 'Image Generator', description: 'Hosted image generation API', docs: item.docs, auth: 'none', sources: [] }))
})
test('OpenAPI uses documented required parameter examples and rejects missing/key operations', () => {
  const spec = { openapi: '3.0.0', servers: [{ url: 'https://books.example.org/v1' }], paths: {
    '/books/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 7 } },
      { name: 'language', in: 'query', required: true, schema: { enum: ['en'] } }] } },
    '/unknown/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
    '/paid': { get: { security: [{ key: [] }] } }, '/health': { get: {} },
  } }
  assert.deepEqual(specificationEndpoints(JSON.stringify(spec), item.docs), ['https://books.example.org/v1/books/7?language=en'])
})
test('Postman is documentation: only concrete public GET requests are resolved', () => {
  const spec = { info: { _postman_id: 'fixture' }, variable: [{ key: 'baseUrl', value: 'https://books.example.org' }], item: [
    { request: { method: 'GET', url: { raw: '{{baseUrl}}/books?title=Example' } } },
    { request: { method: 'POST', url: { raw: '{{baseUrl}}/create' } } },
    { request: { method: 'GET', auth: { type: 'apikey' }, url: { raw: '{{baseUrl}}/paid' } } },
  ] }
  assert.deepEqual(specificationEndpoints(JSON.stringify(spec), item.docs), ['https://books.example.org/books?title=Example'])
})
test('documentation spec selectors are stripped without calling the selected POST operation', async () => {
  const seen: string[] = []
  const network = new Network(async input => {
    const url = String(input)
    seen.push(url)
    if (new URL(url).pathname === '/robots.txt') return new Response('', { status: 404 })
    if (url === item.docs) return new Response('<script>const config = { openapi: "/openapi.json post /create" }</script>')
    if (url === 'https://books.example.org/openapi.json') return Response.json({ openapi: '3.0.0', servers: [{ url: 'https://books.example.org' }], paths: { '/books': { get: {} }, '/create': { post: {} } } })
    if (url === 'https://books.example.org/books') return Response.json({ books: ['Existing book'] })
    return new Response('', { status: 404 })
  })
  assert.equal((await evaluate(item, network)).technical, 'PASSED')
  assert.ok(seen.includes('https://books.example.org/openapi.json'))
  assert.ok(!seen.some(url => /%20|\/create/.test(url)))
})
test('shared provider navigation does not crawl unrelated product documentation', async () => {
  const seen: string[] = [], scoped = { ...item, docs: 'https://books.example.org/books/docs/' }
  const network = new Network(async input => {
    const url = String(input)
    seen.push(url)
    if (new URL(url).pathname === '/robots.txt') return new Response('', { status: 404 })
    if (url === scoped.docs) return new Response('<a href="/unrelated/docs/">Another product</a><a href="/books/docs/reference">Book API</a>', { headers: { 'content-type': 'text/html' } })
    if (url.endsWith('/books/docs/reference')) return new Response('GET https://books.example.org/books')
    if (url === 'https://books.example.org/books') return Response.json({ books: ['Existing book'] })
    return new Response('', { status: 404 })
  })
  assert.equal((await evaluate(scoped, network)).technical, 'PASSED')
  assert.ok(!seen.some(url => url.includes('/unrelated/')))
})
test('curl --get public query parameters are applied instead of testing an empty manifest', () => {
  const doc = { ...page({}), type: 'text/plain', url: item.docs,
    body: "curl --get 'https://books.example.org/search' --data-urlencode 'query=Example book'" }
  assert.equal(examples(doc, item)[0], 'https://books.example.org/search?query=Example+book')
})
test('regression: HTML is never parsed as YAML; explicit remote GET examples allowed', () => {
  assert.deepEqual(specificationEndpoints('<html>&quot;name&quot;: whatever</html>', item.docs), [])
  const remote = { ...page({}), type: 'text/html', url: item.docs, body: 'GET https://public.other.org/v1/books?title=Example' }
  assert.deepEqual(examples(remote, item), [])
  assert.deepEqual(examples({ ...remote, url: 'https://github.com/provider/books' }, { ...item, docs: 'https://github.com/provider/books' }), ['https://public.other.org/v1/books?title=Example'])
})
test('duplicate catalogue identities do not count a single API twice or bypass its prohibition', async () => {
  const result = await evaluate(item, fixture({ [item.docs]: new Response('GET https://books.example.org/books'),
    'https://books.example.org/books': Response.json({ books: ['Example'] }) }).network)
  const first = { lead: item, result, attempts: 1, retryAt: null }
  const alias = { ...first, lead: { ...item, id: digest('alias'), name: 'Alias' } }
  assert.equal(summary([first,alias]).admitted, 2)
  assert.equal(summary([first,alias]).usable, 1)
  assert.equal(summary([first,alias]).successPercent, 50)
  assert.deepEqual(usableCandidates([first,alias]),usableCandidates([alias,first]))
  assert.equal(usableCandidates([first,{ ...alias, result: { ...result, permission: 'PROHIBITED' } }]).length, 0)
})
test('internal list keeps ambiguous terms; explicit prohibitions still exclude aliases', () => {
  const result = { technical: 'PASSED' as const, freeAccess: 'VERIFIED' as const,
    permission: 'REVIEW_REQUIRED' as const, termsChecked: true, endpoint: 'https://books.example.org/books',
    docs: item.docs, lastSuccess: '2026-10-27T00:00:00Z', reason: 'historical proof', retryAt: null,
    evidence: [], tests: [{ url: 'https://books.example.org/books', status: 200, reason: 'historical proof', sha256: 'fixture' }] }
  const row = { lead: item, result, attempts: 1, retryAt: null }
  assert.equal(usable(result), true)
  assert.equal(usableCandidates([row]).length, 1)
  assert.equal(usableCandidates([row, { ...row, lead: { ...item, id: digest('prohibited alias') },
    result: { ...result, permission: 'PROHIBITED' } }]).length, 0)
  assert.equal(usable({ ...result, technical: 'FAILED' }), false)
  assert.equal(usable({ ...result, freeAccess: 'UNVERIFIED' }), false)
})
test('denominator retains failed, unresolved and untested admissions', async () => {
  const pending = { lead: item, result: null, attempts: 0, retryAt: null }
  const result = await evaluate(item, fixture({ [item.docs]: new Response('GET https://books.example.org/books'),
    'https://books.example.org/books': Response.json({ books: ['Example'] }) }).network)
  const counts = summary([{ ...pending, result }, pending, pending, pending])
  assert.equal(counts.admitted, 4); assert.equal(counts.usable, 1); assert.equal(counts.successPercent, 25)
  assert.equal(counts.permissions.UNKNOWN, 4); assert.equal(counts.termsChecked, 1)
})

test('Phase 1: successful request checkpoint survives interrupted terms without an API retest', async () => {
  let dispatches = 0, stopped = false
  const transport = new Network(async input => {
    const path = new URL(input).pathname
    if (path === '/robots.txt') return new Response('', { status: 404 })
    if (path === '/docs') return new Response('GET https://books.example.org/books')
    if (path === '/books') { dispatches++; return Response.json({ books: [{ title: 'Saved book' }], legal: 'You must not resell access to this API service.' }) }
    return new Response('', { status: 404 })
  }, {}, undefined, undefined, async () => !stopped)
  let checkpoint: Awaited<ReturnType<typeof evaluate>> | undefined
  const interrupted = await evaluate(item, transport, null, async result => { checkpoint = result; stopped = true })
  assert.equal(dispatches, 1)
  assert.equal(checkpoint?.technical, 'PASSED'); assert.equal(checkpoint?.termsChecked, false)
  assert.equal(interrupted.technical, 'PASSED'); assert.equal(interrupted.termsChecked, false)
  stopped = false
  transport.clearDocuments()
  const resumed = await evaluate(item, transport, checkpoint)
  assert.equal(dispatches, 1); assert.equal(resumed.termsChecked, true)
  assert.equal(resumed.permission, 'PROHIBITED', 'Response-provided restrictions must survive a checkpoint')
  transport.clearDocuments(); assert.equal(transport.documentBytes, 0)
})

test('Phase 1: fifty-document batches keep cache bounded and release it between batches', async () => {
  const network = new Network(async input => String(input).endsWith('/robots.txt') ? new Response('', { status: 404 })
    : new Response('x'.repeat(1_000_000)))
  for (let batch = 0; batch < 4; batch++) {
    for (let index = 0; index < 50; index++) {
      await network.page(`https://memory.example.org/docs/${batch}/${index}`)
      assert.ok(network.documentBytes <= 32 * 1024 * 1024)
    }
    network.clearDocuments(); assert.equal(network.documentBytes, 0)
  }
})
