import { build } from 'esbuild'
import { resolve } from 'node:path'
const root = process.cwd()
const stub = resolve('tests/provider-auth/browser-stubs.jsx')
await build({ entryPoints: ['tests/provider-auth/browser-client.jsx'], bundle: true, platform: 'browser',
  outfile: process.env.MAHSHAR_BROWSER_BUNDLE ?? '/tmp/mahshar-auth-browser.js', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { 'wagmi': stub, 'next/navigation': stub, '@/components/MarketplaceSessionProvider': stub, '@': resolve(root, 'src') },
})
console.log('Bundled actual Seller components for isolated browser tests')
