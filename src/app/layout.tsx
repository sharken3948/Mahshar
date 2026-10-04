import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { headers } from 'next/headers';
import { cookieToInitialState } from 'wagmi';
import { Providers, wagmiConfig } from './providers';
import { SolanaProviders } from './SolanaProviders';
import { BRAND_ICONS, HOME_DESCRIPTION, HOME_TITLE, MAHSHAR_ORIGIN } from '@/lib/seo/brand';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  metadataBase: new URL(MAHSHAR_ORIGIN),
  openGraph: {
    type: 'website',
    siteName: 'Mahshar',
    images: [{ url: '/logo.png', width: 1024, height: 559, alt: 'Mahshar' }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/logo.png'],
  },
  icons: BRAND_ICONS,
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
