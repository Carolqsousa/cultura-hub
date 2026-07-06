import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // BigQuery client runs only server-side; exclude from browser bundle
  serverExternalPackages: ["@google-cloud/bigquery"],

  async redirects() {
    return [
      {
        source: "/comercial",
        destination: "/commercial",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
