export const MAHSHAR_ORIGIN = 'https://mahshar.xyz'
export const MAHSHAR_NAME = 'Mahshar'

export const HOME_TITLE = 'Mahshar | API Marketplace for AI Agents'
export const HOME_DESCRIPTION = 'Mahshar is an API marketplace where AI agents and builders discover APIs and pay per call with USDC on Arc Mainnet.'

export const BRAND_ICON = { url: '/icon.png', sizes: '512x512', type: 'image/png' } as const
export const BRAND_ICONS = { icon: [BRAND_ICON], apple: [BRAND_ICON] }

export const homepageStructuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: MAHSHAR_NAME, url: MAHSHAR_ORIGIN },
    { '@type': 'Organization', name: MAHSHAR_NAME, url: MAHSHAR_ORIGIN, logo: `${MAHSHAR_ORIGIN}/logo.png` },
  ],
} as const
