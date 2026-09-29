// Direct imports ensure node:test registers each case under Node 20 + this TSX build.
// node --test reports only file-level success here, so use this entry point.
await import('./listing-security-match.test.ts')
await import('./security.test.ts')
await import('./session-auth.test.ts')
await import('./client-session.test.ts')
await import('../../src/lib/proxy-policy.test.ts')
await import('../../src/lib/proxy-response.test.ts')
await import('./agent-discovery.test.ts')
await import('./rate-limit.test.ts')
await import('./arc-balance-route.test.ts')
await import('./seller-onboarding.test.ts')
await import('./seller-analysis.test.ts')
