# Dynamic Circle Mainnet routes

BridgeKit 1.15.1 supplies the candidate universe through `getSupportedChains({ isTestnet: false })`. `discoverCircleRoutes` calls each default provider's public `supportsRoute(source, Arc, 'USDC')` in SDK selection order, then checks forwarding on the selected provider. Unsupported routes and unsupported browser ecosystems are excluded. No manually maintained source allowlist, chain IDs, CCTP domains or contract builders are used.

## Solana → Arc workspace

The dedicated dashboard route at `/dashboard/solana` is presented as **Solana → Arc** because it is directional: the connected Solana wallet is the source, and the connected EVM wallet on Arc Mainnet is the destination. It moves supported SPL USDC to Arc. Depositing received USDC into Mahshar Balance remains a separate, explicit wallet action.

The installed registry contains 26 Mainnets. It confirms 25 native-USDC routes to Arc, all forwarding-capable: Arbitrum, Avalanche, Base, Codex Mainnet, Cronos, Edge, Ethereum, HyperEVM, Injective, Ink, Linea, Monad, Morph, Optimism, Pharos, Plasma, Plume, Polygon, Sei, Solana, Sonic, Unichain, World Chain, XDC and X Layer. Arc itself is the destination, not a bridge source. These counts describe the installed SDK, not a frozen application configuration.

Wallet configuration, names, currencies, RPCs and native-USDC addresses derive from Circle definitions. SDK metadata has no chain icon field; the existing UI initials remain. EVM sources use Circle's browser viem adapter; Solana uses its browser Solana adapter. The only recipient is the connected EVM wallet on Arc. Circle forwarding is preferred. If a confirmed route does not support forwarding, a separate official viem destination adapter handles Arc mint signing; the UI explains the additional signature and Arc gas requirement. SDK retry retains this delivery mode and never starts a new burn. Capability is checked again before execution.

The existing Gateway deposit reads actual Arc USDC; x402, Memo, accounting and withdrawal logic are unchanged. No wallet was opened, no signatures requested, and no transaction or remote DB operation performed. SDK additions/removals flow through registry/capability checks after the dependency is updated and the application rebuilt; no per-chain application edits are needed for supported EVM/Solana ecosystems.

Read-only local capability report: `node --import tsx scripts/get-supported-chains.mts`. This does not create an adapter or execute a bridge. `scripts/verify-usdc-mainnet.mts` also derives its EVM list from this catalog; it performs live read-only RPC checks only when explicitly run, and was not run for this change.

Validation: 37 offline tests passed, covering every current EVM source, Solana, route removal, automatic SDK-chain addition, recipient/network checks, recovery and official destination-adapter behavior without forwarding. Production webpack build passed, including Next TypeScript checking; the existing upstream ox/viem dynamic-dependency warning remains. No live bridge or wallet signing was tested.

Final standalone `tsc --noEmit --incremental false` also passed after the build. The read-only capability-report script confirmed 26 candidates, 25 supported routes and 25 forwarding routes; only Arc was excluded as the destination.
