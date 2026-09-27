import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOutboundUrlShapeAllowed, isProhibitedOutboundAddress, safeOutboundFetch, createPinnedRequestOptions } from './outbound-fetch';

const publicAddress = { address: '93.184.216.34', family: 4 as const };

test('allows ordinary HTTPS URLs and enforces the port and URL policy', () => {
  assert.equal(isOutboundUrlShapeAllowed('https://api.example/v1'), true);
  for (const url of [
    'http://api.example/', 'https://user:pass@api.example/', 'https://api.example/#frag',
    'https://localhost/', 'https://service.local/', 'https://metadata.internal/',
    'https://api.example:8443/', 'https://127.0.0.1/', 'https://[::1]/',
  ]) assert.equal(isOutboundUrlShapeAllowed(url), false, url);
});

test('rejects prohibited IPv4 and IPv6 destination ranges including mapped IPv4', () => {
  for (const address of [
    '0.0.0.0', '10.4.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.31.255.255', '192.168.1.2', '192.0.2.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1',
    'fdff::1', 'fe80::1', 'febf:ffff::1', 'ff02::1', '2001:db8::1',
    '::ffff:10.1.2.3', '::ffff:192.168.1.1', '3fff::1',
  ]) assert.equal(isProhibitedOutboundAddress(address), true, address);
  assert.equal(isProhibitedOutboundAddress('2606:4700:4700::1111'), false);
});

test('resolves and checks all answers; mixed public and blocked answers fail closed', async () => {
  const response = await safeOutboundFetch('https://public.example/data', {}, {
    resolver: async () => [publicAddress],
    requester: async () => new Response('ok'),
  });
  assert.equal(await response.text(), 'ok');
  await assert.rejects(safeOutboundFetch('https://rebind.example/', {}, {
    resolver: async () => [publicAddress, { address: '10.0.0.8', family: 4 }],
    requester: async () => { throw new Error('must not connect'); },
  }), /blocked_destination/);
});

test('request-time validation prevents a public-validation/private-connection rebinding', async () => {
  let calls = 0;
  await safeOutboundFetch('https://rebind.example/', {}, {
    resolver: async () => { calls++; return [publicAddress]; },
    requester: async () => new Response(null),
  });
  await assert.rejects(safeOutboundFetch('https://rebind.example/', {}, {
    resolver: async () => {
      calls++;
      return [{ address: '127.0.0.1', family: 4 }];
    },
    requester: async () => { throw new Error('must not connect'); },
  }), /blocked_destination/);
  assert.equal(calls, 2);
});

test('DNS resolution is included in the bounded outbound timeout', async () => {
  await assert.rejects(safeOutboundFetch('https://slow.example/', {}, {
    timeoutMs: 2,
    resolver: async () => new Promise(() => undefined),
    requester: async () => { throw new Error('must not connect'); },
  }), /timeout/);
});

test('the HTTPS socket lookup is pinned and normal TLS hostname verification remains enabled', async () => {
  const options = createPinnedRequestOptions(new URL('https://api.example/path'), publicAddress);
  assert.equal(options.hostname, 'api.example');
  assert.equal(options.servername, 'api.example');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  let answer: unknown[] = [];
  (options.lookup as unknown as (...args: unknown[]) => void)('api.example', {}, (...args: unknown[]) => { answer = args; });
  assert.deepEqual(answer, [null, publicAddress.address, 4]);
  let allAnswer: unknown[] = [];
  (options.lookup as unknown as (...args: unknown[]) => void)('api.example', { all: true }, (...args: unknown[]) => { allAnswer = args; });
  assert.deepEqual(allAnswer, [null, [{ address: publicAddress.address, family: 4 }]]);
});

test('credential preparation runs only after full destination validation', async () => {
  let prepared = false;
  await assert.rejects(safeOutboundFetch('https://blocked.example/', () => {
    prepared = true;
    return { headers: { authorization: 'Bearer test-secret' } };
  }, { resolver: async () => [{ address: '192.168.0.10', family: 4 }] }), /blocked_destination/);
  assert.equal(prepared, false);
});

test('redirects are returned without following and credential factory runs once', async () => {
  let calls = 0;
  const response = await safeOutboundFetch('https://public.example/', () => {
    calls++;
    return { redirect: 'manual', headers: { authorization: 'Bearer test-secret' } };
  }, {
    resolver: async () => [publicAddress],
    requester: async (url, address, init) => {
      assert.equal(url.hostname, 'public.example');
      assert.deepEqual(address, publicAddress);
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-secret');
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } });
    },
  });
  assert.equal(response.status, 302);
  assert.equal(calls, 1);
});
