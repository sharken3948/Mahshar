import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { headers } from 'next/headers';
import { cookieToInitialState } from 'wagmi';
import { Providers, wagmiConfig } from './providers';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: 'Mahshar: The API Economy, Powered by USDC',
  description: 'Buy and sell API access with instant USDC micropayments. AI-matched, x402-powered, zero integration.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://mahshar.xyz'),
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
      <body className="min-h-full flex flex-col"><Providers initialState={initialState}>{children}</Providers></body>
    </html>
  );
}
