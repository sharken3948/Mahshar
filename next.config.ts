import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep type checking enabled using the installed TypeScript 5 compiler API.
  // Next 16.3's subprocess --showConfig returns empty output in this environment.
  experimental: { useTypeScriptCli: false },
};

export default nextConfig;
