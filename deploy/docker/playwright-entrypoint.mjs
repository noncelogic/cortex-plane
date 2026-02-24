/**
 * Playwright CDP Sidecar Entrypoint
 *
 * Launches headless Chromium via Playwright and exposes Chrome DevTools Protocol
 * on 0.0.0.0:9222. Handles SIGTERM for graceful pod shutdown.
 */
import { chromium } from "playwright-core";

const PORT = Number(process.env.CDP_PORT ?? 9222);

const browser = await chromium.launchServer({
  headless: true,
  port: PORT,
  host: "0.0.0.0",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-first-run",
  ],
});

console.log(`CDP sidecar listening: ${browser.wsEndpoint()}`);

const shutdown = async () => {
  console.log("Shutting down CDP sidecar...");
  await browser.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
