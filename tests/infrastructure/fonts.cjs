// Installed Next fonts through its offline test seam. No downloads or product changes.
const path = require('node:path')
module.exports = new Proxy({}, { get: (_, url) => {
  const mono = String(url).includes('Geist+Mono')
  const file = path.resolve(__dirname, '../../node_modules/next/dist/next-devtools/server/font', mono ? 'geist-mono-latin.woff2' : 'geist-latin.woff2')
  return `@font-face { font-family: '${mono ? 'Geist Mono' : 'Geist'}'; font-style: normal; font-weight: 100 900; src: url(${file}) format('woff2'); }`
} })
