import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // BigQuery client runs only server-side; exclude from browser bundle
  serverExternalPackages: ["@google-cloud/bigquery"],
};

export default nextConfig;
