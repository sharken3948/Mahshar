export function buildViewCodeSnippet(apiId: string, appUrl: string, method: string): string {
  const isBodyMethod = method === 'POST' || method === 'PUT'
  const bodyLines = isBodyMethod
    ? [
        `    api_id: '${apiId}',`,
        `    buyer_wallet: gateway.address,`,
        `    method: '${method}',`,
        '    body: { /* your request body here */ },',
      ]
    : [
        `    api_id: '${apiId}',`,
        '    buyer_wallet: gateway.address,',
      ]
  return [
    "import { GatewayClient } from '@circle-fin/x402-batching/client'",
    '',
    'const gateway = new GatewayClient({',
    "  chain: 'arcTestnet',",
    '  privateKey: process.env.WALLET_PRIVATE_KEY,',
    '})',
    '',
    `const { data } = await gateway.pay('${appUrl}/api/proxy', {`,
    "  method: 'POST',",
    '  body: {',
    ...bodyLines,
    '  },',
    '})',
    '',
    'console.log(data)',
  ].join('\n')
}

export function renderHighlightedSnippet(snippet: string) {
  return snippet.split('\n').map((line, i, arr) => {
    const nl = i < arr.length - 1 ? '\n' : ''
    const jsonKv = line.match(/^(\s*"[^"]+": )(.+)$/)
    if (jsonKv) {
      return (
        <span key={i}>{jsonKv[1]}<span className="text-[#FBBF24]">{jsonKv[2]}</span>{nl}</span>
      )
    }
    if (line.includes('process.env.WALLET_PRIVATE_KEY')) {
      const env = 'process.env.WALLET_PRIVATE_KEY'
      const idx = line.indexOf(env)
      return (
        <span key={i}>{line.slice(0, idx)}<span className="text-[#86EFAC]">{env}</span>{line.slice(idx + env.length)}{nl}</span>
      )
    }
    return <span key={i}>{line}{nl}</span>
  })
}
