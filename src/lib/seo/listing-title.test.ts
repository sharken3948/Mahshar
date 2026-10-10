import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listingMetadataTitle } from './listing'

test('listing metadata titles do not duplicate an existing API suffix', () => {
  assert.equal(
    listingMetadataTitle({ name: 'Anewone Token Data & Bot Integration API' }),
    'Anewone Token Data & Bot Integration API — Pay per Call with USDC | Mahshar',
  )
  assert.equal(
    listingMetadataTitle({ name: 'Anewone Token Data & Bot Integration api' }),
    'Anewone Token Data & Bot Integration api — Pay per Call with USDC | Mahshar',
  )
})

test('listing metadata titles append the API suffix for names without one', () => {
  assert.equal(
    listingMetadataTitle({ name: 'Wallet Risk Scoring' }),
    'Wallet Risk Scoring API — Pay per Call with USDC | Mahshar',
  )
})
