import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/memory-scheduling.integration.test.*",
      "**/migrations.test.*",
      "**/worker-integration.test.*",
    ],
  },
})
