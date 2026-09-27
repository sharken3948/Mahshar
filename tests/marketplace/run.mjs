// Direct imports ensure node:test registers each case under Node 20 + this TSX build.
// node --test reports only file-level success here, so use this entry point.
await import('./security.test.ts')
await import('./client-session.test.ts')
await import('../../src/lib/proxy-policy.test.ts')
await import('../../src/lib/proxy-response.test.ts')
await import('./agent-discovery.test.ts')
await import('./rate-limit.test.ts')
