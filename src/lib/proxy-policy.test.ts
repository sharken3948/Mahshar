import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveListingProxyMethod } from './proxy-policy';

test('listing method controls the upstream method when caller omits it', () => {
  assert.deepEqual(resolveListingProxyMethod(undefined, 'POST'), { method: 'POST' });
  assert.deepEqual(resolveListingProxyMethod('put', 'PUT'), { method: 'PUT' });
});

test('mismatched and unsupported caller methods are rejected', () => {
  assert.deepEqual(resolveListingProxyMethod('GET', 'POST'), { error: 'Caller HTTP method does not match listing method' });
  assert.deepEqual(resolveListingProxyMethod('PATCH', 'POST'), { error: 'Caller HTTP method is unsupported' });
  assert.deepEqual(resolveListingProxyMethod(undefined, 'PATCH'), { error: 'Listing HTTP method is unsupported' });
});
