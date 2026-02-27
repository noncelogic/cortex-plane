import type { NextConfig } from "next"

const config: NextConfig = {
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },
}

export default config
