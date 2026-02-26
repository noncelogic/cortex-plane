import type { NextConfig } from "next"

const config: NextConfig = {
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Proxy API requests to the control plane in development
  async rewrites() {
    const apiUrl = process.env.CORTEX_API_URL ?? "http://localhost:4000"
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/:path*`,
      },
    ]
  },
}

export default config
