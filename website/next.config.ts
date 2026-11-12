import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  experimental: {
    // Vercel restores .next/cache between builds. On 2026-11-12 Turbopack's
    // build cache served the OLD globals.css against new pages, so production
    // shipped unstyled. The site builds in seconds; compile from source.
    turbopackFileSystemCacheForBuild: false,
  },
  async redirects() {
    // Pricing was removed on 2026-11-12. Old links land on the homepage.
    return [{ source: "/pricing", destination: "/", permanent: true }];
  },
  async rewrites() {
    return [
      {
        source: "/api/backend/:path*",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
