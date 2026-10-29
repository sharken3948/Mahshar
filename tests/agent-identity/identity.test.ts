import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, toHex, zeroAddress, type Hex } from 'viem'
import { NextRequest } from 'next/server'
import * as route from '../../src/app/api/agent/identity/route'
import { IDENTITY_REGISTRY, parseIdentityQuery, readAgentIdentity } from '../../src/lib/agent-identity'
import { database } from './database'

const snapshot = JSON.parse(readFileSync('tests/agent-identity/registry-snapshot.json', 'utf8'))
const owner = '0x1111111111111111111111111111111111111111'
const agentWallet = '0x2222222222222222222222222222222222222222'
const operator = '0x3333333333333333333333333333333333333333'
const abi = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function getVersion() view returns (string)',
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'error ERC721NonexistentToken(uint256 tokenId)',
])
const originalFetch = globalThis.fetch
const previousRpc = process.env.ARC_MAINNET_RPC_URL
let state: ReturnType<typeof initialState>
function initialState() {
  return { chain: 5042, owner, wallet: agentWallet, proxy: snapshot.proxy,
    implementation: snapshot.implementation, timestamp: Math.floor(Date.now() / 1000),
    missing: false, rpcError: false, malformed: false, reorg: false, invalidInterface: false,
    erc721: true, version: '2.0.0', calls: [] as Array<{ method: string; params: unknown[] }>,
    decodedIds: [] as bigint[], headers: [] as Headers[] }
}

beforeEach(() => {
  state = initialState()
  database.calls = []; database.allowed = true; database.unavailable = false
  process.env.ARC_MAINNET_RPC_URL = 'https://identity-rpc.invalid/secret-token'
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), process.env.ARC_MAINNET_RPC_URL, 'no metadata, other RPC or application URL may be fetched')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.cache, 'no-store')
    state.headers.push(new Headers(init?.headers))
    const { id, method, params } = JSON.parse(String(init?.body))
    state.calls.push({ method, params })
    if (state.rpcError) throw new Error('sensitive provider details: secret-token')
    let result: unknown
    switch (method) {
      case 'eth_chainId': result = toHex(state.chain); break
      case 'eth_getBlockByNumber':
        result = { number: toHex(BigInt(snapshot.block_number)), timestamp: toHex(state.timestamp),
          hash: state.reorg && params[0] !== 'latest' ? '0x' + 'ab'.repeat(32) : snapshot.block_hash,
          transactions: [] }; break
      case 'eth_getCode':
        assert.equal(params[1], toHex(BigInt(snapshot.block_number)))
        result = params[0].toLowerCase() === IDENTITY_REGISTRY.toLowerCase() ? state.proxy : state.implementation; break
      case 'eth_getStorageAt':
        assert.equal(params[2], toHex(BigInt(snapshot.block_number)))
        result = '0x' + '0'.repeat(24) + snapshot.implementation_address.slice(2); break
      case 'eth_call': {
        assert.equal(params[0].to.toLowerCase(), IDENTITY_REGISTRY.toLowerCase())
        assert.equal(params[1], toHex(BigInt(snapshot.block_number)))
        const call = decodeFunctionData({ abi, data: params[0].data })
        if (call.functionName === 'ownerOf' || call.functionName === 'getAgentWallet') state.decodedIds.push(call.args[0])
        if (state.missing && call.functionName === 'ownerOf') {
          return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted',
            data: encodeErrorResult({ abi, errorName: 'ERC721NonexistentToken', args: [call.args[0]] }) } })
        }
        if (state.malformed && call.functionName === 'getAgentWallet') { result = '0x'; break }
        switch (call.functionName) {
          case 'getVersion': result = encodeFunctionResult({ abi, functionName: call.functionName, result: state.version }); break
          case 'ownerOf': result = encodeFunctionResult({ abi, functionName: call.functionName, result: state.owner as Hex }); break
          case 'getAgentWallet': result = encodeFunctionResult({ abi, functionName: call.functionName, result: state.wallet as Hex }); break
          case 'supportsInterface': result = encodeFunctionResult({ abi, functionName: call.functionName,
            result: call.args[0] === '0xffffffff' ? state.invalidInterface : call.args[0] === '0x80ac58cd' ? state.erc721 : true }); break
        }
        break
      }
      default: throw new Error(`Unexpected RPC method: ${method}`)
    }
    return Response.json({ jsonrpc: '2.0', id, result })
  }
})

after(() => {
  globalThis.fetch = originalFetch
  if (previousRpc === undefined) delete process.env.ARC_MAINNET_RPC_URL
  else process.env.ARC_MAINNET_RPC_URL = previousRpc
})

function params(id = '0', wallet?: string) {
  return new URLSearchParams({ chain_id: '5042', registry: IDENTITY_REGISTRY, agent_id: id,
    ...(wallet ? { wallet } : {}) })
}
async function lookup(query = params(), headers?: HeadersInit) {
  return route.GET(new NextRequest(`https://mahshar.xyz/api/agent/identity?${query}`, { headers }))
}

test('machine-readable discovery needs no cookie, wallet, database or RPC', async () => {
  delete process.env.ARC_MAINNET_RPC_URL
  const response = await lookup(new URLSearchParams())
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.mode, 'public_onchain_lookup')
  assert.equal(body.persistent_binding_supported, false)
  assert.deepEqual(body.required_query, ['chain_id', 'registry', 'agent_id'])
  assert.equal(database.calls.length, 0)
  assert.equal(state.calls.length, 0)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('set-cookie'), null)
})

test('agent zero resolves live public facts, not caller authentication', async () => {
  const response = await lookup(params('0', owner))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.agent_id, '0')
  assert.equal(body.chain_id, 5042)
  assert.equal(body.registry, IDENTITY_REGISTRY)
  assert.equal(body.owner, owner)
  assert.equal(body.agent_wallet, agentWallet)
  assert.deepEqual(body.wallet_relationship, { wallet: owner, is_owner: true, is_agent_wallet: false })
  assert.equal(body.requester_authenticated, false)
  assert.equal(body.binding_created, false)
  assert.equal(body.block.number, snapshot.block_number)
  assert.equal(body.block.hash, snapshot.block_hash)
  assert.deepEqual(state.decodedIds, [BigInt(0), BigInt(0)])
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('large uint256 IDs retain exact decimal precision end to end', async () => {
  for (const id of ['9007199254740993', ((BigInt(1) << BigInt(256)) - BigInt(1)).toString()]) {
    const response = await lookup(params(id))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).agent_id, id)
    assert.equal(state.decodedIds.at(-1), BigInt(id))
  }
})

test('strict tuple/query validation rejects ambiguity, URLs and metadata claims before any I/O', async () => {
  const bad: URLSearchParams[] = []
  for (const id of ['', '-1', '00', '01', '+1', '1.0', '1e3', '0x1', ' 1', '1 ', '9'.repeat(79), (BigInt(1) << BigInt(256)).toString()]) bad.push(params(id))
  for (const [key, value] of [['chain_id', '1'], ['registry', operator], ['wallet', zeroAddress],
    ['wallet', 'bad'], ['buyer_wallet', owner], ['metadata', 'http://169.254.169.254'],
    ['rpc_url', 'http://localhost'], ['agent_uri', 'file:///etc/passwd']]) {
    const query = params(); query.set(key, value); bad.push(query)
  }
  for (const key of ['chain_id', 'registry', 'agent_id']) {
    const query = params(); query.delete(key); bad.push(query)
  }
  for (const key of ['chain_id', 'registry', 'agent_id', 'wallet']) {
    const query = params('0', owner); query.append(key, query.get(key)!); bad.push(query)
  }
  for (const query of bad) {
    const response = await lookup(query)
    assert.equal(response.status, 400, query.toString())
    assert.equal((await response.json()).error, 'invalid_identity_query')
  }
  assert.equal(state.calls.length, 0)
  assert.equal(database.calls.length, 0)
})

test('wallet switching, transfer and agent-wallet replacement never reuse a prior relationship', async () => {
  assert.equal((await (await lookup(params('0', owner))).json()).wallet_relationship.is_owner, true)
  assert.equal((await (await lookup(params('0', agentWallet))).json()).wallet_relationship.is_agent_wallet, true)
  state.owner = operator; state.wallet = zeroAddress
  const transferred = await (await lookup(params('0', owner))).json()
  assert.deepEqual(transferred.wallet_relationship, { wallet: owner, is_owner: false, is_agent_wallet: false })
  assert.equal(transferred.agent_wallet, null)
  state.wallet = owner
  assert.equal((await (await lookup(params('0', agentWallet))).json()).wallet_relationship.is_agent_wallet, false)
  assert.equal((await (await lookup(params('0', owner))).json()).wallet_relationship.is_agent_wallet, true)
})

test('operator-only permissions do not qualify; no approvals or metadata are consulted', async () => {
  const body = await (await lookup(params('0', operator))).json()
  assert.deepEqual(body.wallet_relationship, { wallet: operator, is_owner: false, is_agent_wallet: false })
  assert.equal(body.requester_authenticated, false)
  // The RPC fixture rejects every method outside the narrow registry ABI.
  assert.equal(body.binding_created, false)
})

test('EOAs and contract wallets are compared as addresses, without a false ERC-1271 proof claim', async () => {
  state.wallet = state.owner
  const body = await (await lookup(params('0', owner))).json()
  assert.equal(body.wallet_relationship.is_owner, true)
  assert.equal(body.wallet_relationship.is_agent_wallet, true)
  assert.equal(body.requester_authenticated, false)
  assert.equal(state.calls.filter(c => c.method === 'eth_getCode').length, 2, 'only registry bytecode is read')
})

test('cookies, payment signatures and purchase capabilities confer no identity authority or private access', async () => {
  const response = await lookup(params('0', owner), { cookie: 'mahshar_session=unrelated-wallet',
    'payment-signature': 'purchase-specific-proof', 'x-mahshar-purchase-access': 'private-purchase-token' })
  const body = await response.json()
  assert.equal(body.requester_authenticated, false)
  assert.equal(body.binding_created, false)
  assert.deepEqual(database.calls.map(c => c.name), ['mahshar_take_rate_limit'])
  assert.equal(response.headers.get('set-cookie'), null)
  assert.ok(!JSON.stringify(body).includes('private-purchase-token'))
  for (const headers of state.headers) {
    assert.equal(headers.get('cookie'), null)
    assert.equal(headers.get('payment-signature'), null)
    assert.equal(headers.get('x-mahshar-purchase-access'), null)
  }
})

test('known nonexistent token is 404; RPC/decode failures are sanitized 503, never a false negative', async () => {
  state.missing = true
  const missing = await lookup()
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error, 'agent_not_found')
  state.missing = false; state.malformed = true
  assert.equal((await lookup()).status, 503)
  state.malformed = false; state.rpcError = true
  const failure = await lookup()
  assert.equal(failure.status, 503)
  assert.equal(await failure.text(), JSON.stringify({ error: 'identity_unavailable', requester_authenticated: false, binding_created: false }))
})

test('wrong chain, missing deployment, upgrades, interface changes and zero owners fail closed', async () => {
  for (const change of [() => { state.chain = 1 }, () => { state.proxy = '0x' },
    () => { state.implementation = '0x6000' }, () => { state.version = '3.0.0' },
    () => { state.erc721 = false }, () => { state.invalidInterface = true }, () => { state.owner = zeroAddress }]) {
    state = initialState(); change()
    assert.equal((await lookup()).status, 503)
  }
})

test('stale, future and reorganized block snapshots are rejected', async () => {
  state.timestamp -= 121
  assert.equal((await lookup()).status, 503)
  state.timestamp = Math.floor(Date.now() / 1000) + 60
  assert.equal((await lookup()).status, 503)
  state = initialState(); state.reorg = true
  assert.equal((await lookup()).status, 503)
  state.missing = true
  assert.equal((await lookup()).status, 503, 'a reorganized snapshot must not assert nonexistence')
})

test('missing configured RPC fails locally with no fallback or external calls', async () => {
  delete process.env.ARC_MAINNET_RPC_URL
  assert.equal((await lookup()).status, 503)
  assert.equal(state.calls.length, 0)
})

test('rate limiting is isolated from wallet claims and fails closed before RPC', async () => {
  await lookup(params('0', owner)); await lookup(params('0', agentWallet))
  assert.equal(database.calls[0].args.p_key_hash, database.calls[1].args.p_key_hash)
  state.calls = []; database.allowed = false
  const limited = await lookup()
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  assert.equal(state.calls.length, 0)
  database.unavailable = true
  assert.equal((await lookup()).status, 503)
  assert.equal(state.calls.length, 0)
})

test('reader never accesses the database and exposes no persistent mutation handler', async () => {
  const identity = await readAgentIdentity(parseIdentityQuery(params()))
  assert.equal(identity.agent_id, '0')
  assert.equal(database.calls.length, 0)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(method in route, false)
})

test('a slow RPC is bounded and returns only an availability failure', async () => {
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('RPC timed out')), { once: true })
  })
  const start = Date.now()
  const response = await lookup()
  assert.equal(response.status, 503)
  assert.ok(Date.now() - start < 7000)
})
