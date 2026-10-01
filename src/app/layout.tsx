import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { headers } from 'next/headers';
import { cookieToInitialState } from 'wagmi';
import { Providers, wagmiConfig } from './providers';
import { SolanaProviders } from './SolanaProviders';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: 'Mahshar — AI API Marketplace Powered by USDC',
  description: 'Discover APIs for AI agents and applications, then pay per call with USDC via x402 on Arc Mainnet.',
  metadataBase: new URL('https://mahshar.xyz'),
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    images: [{ url: '/logo.png', width: 1024, height: 559, alt: 'Mahshar' }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/logo.png'],
  },
  icons: {
    icon: [
      { url: '/icon.png', sizes: '512x512', type: 'image/png' },
      { url: '/icon.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/icon.png',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const cookie = headersList.get('cookie');
  const initialState = cookieToInitialState(wagmiConfig, cookie);

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><SolanaProviders><Providers initialState={initialState}>{children}</Providers></SolanaProviders></body>
    </html>
  );
}
