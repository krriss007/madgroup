/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@tradepilot/shared'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // The API and WebSocket live behind the same origin via server.ts, so no
  // rewrites are needed and the browser never talks to localhost directly.
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
