import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async rewrites() {
    return [
      {
        source: "/api/backend/:path*",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
  async redirects() {
    return [
      // The Salesforce/Agentforce wedge was retired; send the old funnel to book-demo.
      { source: "/connect-salesforce", destination: "/book-demo", permanent: false },
    ];
  },
};

export default nextConfig;
