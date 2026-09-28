import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep type checking enabled using the installed TypeScript 5 compiler API.
  // Next 16.3's subprocess --showConfig returns empty output in this environment.
  experimental: { useTypeScriptCli: false },
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.mahshar.xyz' }],
        destination: 'https://mahshar.xyz/:path*',
        permanent: true,
      },
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'mahshar.vercel.app' }],
        destination: 'https://mahshar.xyz/:path*',
        permanent: true,
      },
    ]
  },
};

export default nextConfig;
