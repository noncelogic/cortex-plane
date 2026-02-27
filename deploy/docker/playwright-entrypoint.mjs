/**
 * Playwright CDP Sidecar Entrypoint
 *
 * Launches Xvfb (virtual framebuffer) → Chromium (displayed on Xvfb) →
 * x11vnc (VNC server) → websockify (WebSocket bridge for noVNC).
 *
 * Ports:
 *   9222 — Chrome DevTools Protocol
 *   5900 — Raw VNC (x11vnc)
 *   6080 — WebSocket VNC via websockify (consumed by noVNC in the dashboard)
 *
 * Environment variables:
 *   CDP_PORT          — CDP listen port (default 9222)
 *   VNC_PORT          — Raw VNC port (default 5900)
 *   WEBSOCKIFY_PORT   — websockify WS port (default 6080)
 *   VNC_ENABLED       — Set to "false" to skip VNC entirely (default "true")
 *   DISPLAY           — X11 display (default ":99")
 *   SCREEN_WIDTH      — Virtual screen width (default 1280)
 *   SCREEN_HEIGHT     — Virtual screen height (default 720)
 *   SCREEN_DEPTH      — Virtual screen color depth (default 24)
 */
import { chromium } from "playwright-core"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const CDP_PORT = Number(process.env.CDP_PORT ?? 9222)
const VNC_PORT = Number(process.env.VNC_PORT ?? 5900)
const WEBSOCKIFY_PORT = Number(process.env.WEBSOCKIFY_PORT ?? 6080)
const VNC_ENABLED = (process.env.VNC_ENABLED ?? "true") !== "false"
const DISPLAY = process.env.DISPLAY || ":99"
const SCREEN_WIDTH = Number(process.env.SCREEN_WIDTH ?? 1280)
const SCREEN_HEIGHT = Number(process.env.SCREEN_HEIGHT ?? 720)
const SCREEN_DEPTH = Number(process.env.SCREEN_DEPTH ?? 24)

const children = []

function spawnTracked(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: "pipe", ...opts })
  children.push(child)
  child.stdout?.on("data", (d) => process.stdout.write(`[${cmd}] ${d}`))
  child.stderr?.on("data", (d) => process.stderr.write(`[${cmd}] ${d}`))
  child.on("error", (err) => console.error(`[${cmd}] spawn error:`, err.message))
  return child
}

// ---------------------------------------------------------------------------
// 1. Start Xvfb (virtual X11 display) if VNC is enabled
// ---------------------------------------------------------------------------
if (VNC_ENABLED) {
  const screenSpec = `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}`
  const xvfb = spawnTracked("Xvfb", [
    DISPLAY,
    "-screen",
    "0",
    screenSpec,
    "-ac",
    "-nolisten",
    "tcp",
  ])

  // Wait for Xvfb to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Xvfb did not start within 5s")), 5000)
    const check = setInterval(async () => {
      try {
        await execFileAsync("xdpyinfo", ["-display", DISPLAY])
        clearInterval(check)
        clearTimeout(timeout)
        resolve()
      } catch {
        // not ready yet
      }
    }, 100)
    xvfb.on("exit", (code) => {
      clearInterval(check)
      clearTimeout(timeout)
      reject(new Error(`Xvfb exited with code ${code}`))
    })
  })

  console.log(`Xvfb running on display ${DISPLAY} (${screenSpec})`)
  process.env.DISPLAY = DISPLAY
}

// ---------------------------------------------------------------------------
// 2. Launch Chromium with CDP
// ---------------------------------------------------------------------------
const launchArgs = [
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
]

// When VNC is enabled, run headed (non-headless) so the GUI renders to Xvfb
const browser = await chromium.launchServer({
  headless: !VNC_ENABLED,
  port: CDP_PORT,
  host: "0.0.0.0",
  args: VNC_ENABLED
    ? [...launchArgs, `--display=${DISPLAY}`, `--window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT}`]
    : launchArgs,
})

console.log(`CDP sidecar listening: ${browser.wsEndpoint()}`)

// ---------------------------------------------------------------------------
// 3. Start x11vnc + websockify if VNC is enabled
// ---------------------------------------------------------------------------
if (VNC_ENABLED) {
  // x11vnc: capture the Xvfb framebuffer on VNC_PORT
  spawnTracked("x11vnc", [
    "-display",
    DISPLAY,
    "-rfbport",
    String(VNC_PORT),
    "-shared",
    "-forever",
    "-nopw",
    "-noxdamage",
    "-wait",
    "5",
    "-defer",
    "5",
  ])

  // websockify: bridge VNC_PORT → WebSocket on WEBSOCKIFY_PORT (for noVNC)
  spawnTracked("websockify", [String(WEBSOCKIFY_PORT), `localhost:${VNC_PORT}`])

  console.log(`VNC server on :${VNC_PORT}, websockify on :${WEBSOCKIFY_PORT}`)
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const shutdown = async () => {
  console.log("Shutting down CDP sidecar...")
  for (const child of children) {
    child.kill("SIGTERM")
  }
  await browser.close()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
