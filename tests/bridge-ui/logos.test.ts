import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { chainLogoPath } from '../../src/app/dashboard/wallet/bridge/chain-logos'

test('every current Circle Mainnet chain has a bundled trusted SVG logo', () => {
  const chains = new BridgeKit().getSupportedChains({ isTestnet: false })
  for (const chain of chains) {
    const path = chainLogoPath(chain.chain)
    assert.ok(path, `${chain.name} logo path`)
    const file = `public${path}`
    assert.ok(existsSync(file), `${chain.name} logo file`)
    assert.match(readFileSync(file, 'utf8'), /<svg\b/)
  }
})
