import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
export function createServiceClient() { return require('./phase3-adapter.ts').createServiceClient() }
