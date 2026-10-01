import type { Metadata } from 'next'

export const aboutMetadata = {
  title: 'What Is Mahshar? AI API Marketplace with USDC',
  description: 'Learn how Mahshar connects API providers, builders, and AI agents through public discovery and pay-per-call USDC access on Arc Mainnet.',
  alternates: { canonical: '/about' },
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    title: 'What Is Mahshar? AI API Marketplace with USDC',
    description: 'A clear guide to Mahshar, x402, USDC pay-per-call APIs, and agent-native API commerce.',
    url: '/about',
  },
  twitter: {
    card: 'summary',
    title: 'What Is Mahshar? AI API Marketplace with USDC',
    description: 'A clear guide to Mahshar, x402, USDC pay-per-call APIs, and agent-native API commerce.',
  },
} satisfies Metadata

export const providersMetadata = {
  title: 'For API Providers — Pay-per-Call API Monetization | Mahshar',
  description: 'Learn how API providers can list an existing endpoint for discoverable, pay-per-call USDC access by builders and AI agents on Mahshar.',
  alternates: { canonical: '/providers' },
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    title: 'For API Providers — Pay-per-Call API Monetization | Mahshar',
    description: 'Offer an existing API through Mahshar’s discovery and x402 pay-per-call access layer.',
    url: '/providers',
  },
  twitter: {
    card: 'summary',
    title: 'For API Providers — Pay-per-Call API Monetization | Mahshar',
    description: 'Offer an existing API through Mahshar’s discovery and x402 pay-per-call access layer.',
  },
} satisfies Metadata
