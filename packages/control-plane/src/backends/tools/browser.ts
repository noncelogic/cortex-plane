import { randomUUID } from "node:crypto"

import type { Kysely } from "kysely"

import type { Database } from "../../db/types.js"
import type { BrowserNavigateResult, BrowserObservationService } from "../../observation/service.js"
import type { ToolDefinition } from "../tool-executor.js"

export interface BrowserToolDeps {
  agentId: string
  db: Kysely<Database>
  observationService: BrowserObservationService
}

export function createPlaywrightNavigateTool(deps: BrowserToolDeps): ToolDefinition {
  const { agentId, db, observationService } = deps

  return {
    name: "playwright_navigate",
    description:
      "Navigate the agent browser to a URL, validate the browser connection, and return page observations.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute URL to open in the agent browser session.",
        },
      },
      required: ["url"],
    },
    execute: async (input: Record<string, unknown>) => {
      const rawUrl = typeof input.url === "string" ? input.url.trim() : ""
      if (!rawUrl) {
        throw new Error("[BROWSER_ACTION_FAILED] url is required")
      }

      let targetUrl: string
      try {
        targetUrl = new URL(rawUrl).toString()
      } catch {
        throw new Error(`[BROWSER_ACTION_FAILED] Invalid URL: ${rawUrl}`)
      }

      const startedAt = Date.now()
      try {
        const result = await observationService.navigate(agentId, targetUrl)
        await persistNavigateSuccess(db, agentId, result, Date.now() - startedAt)

        const screenshot = await captureScreenshotSafe(observationService, agentId)
        if (screenshot) {
          await persistScreenshot(db, agentId, screenshot.url, screenshot.title, screenshot)
        }

        return JSON.stringify(
          {
            ok: true,
            action: "navigate",
            session: result.session,
            page: {
              url: result.url,
              title: result.title,
            },
            tabs: result.tabs,
            screenshot:
              screenshot === null
                ? null
                : {
                    url: screenshot.url,
                    title: screenshot.title,
                    width: screenshot.width,
                    height: screenshot.height,
                    timestamp: screenshot.timestamp,
                  },
          },
          null,
          2,
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "[BROWSER_ACTION_FAILED] Browser action failed"

        await db
          .insertInto("browser_event")
          .values({
            agent_id: agentId,
            type: "ERROR",
            url: targetUrl,
            selector: null,
            message,
            duration_ms: Date.now() - startedAt,
            severity: "error",
          })
          .execute()

        throw error instanceof Error ? error : new Error(message)
      }
    },
  }
}

async function persistNavigateSuccess(
  db: Kysely<Database>,
  agentId: string,
  result: BrowserNavigateResult,
  durationMs: number,
): Promise<void> {
  await db
    .insertInto("browser_event")
    .values({
      agent_id: agentId,
      type: "NAVIGATE",
      url: result.url,
      selector: null,
      message: result.title ? `Navigated to ${result.title}` : `Navigated to ${result.url}`,
      duration_ms: durationMs,
      severity: "info",
    })
    .execute()
}

async function captureScreenshotSafe(
  observationService: BrowserObservationService,
  agentId: string,
): Promise<{
  data: string
  format: "jpeg" | "png"
  width: number
  height: number
  timestamp: string
  url: string
  title: string
} | null> {
  try {
    return await observationService.captureScreenshot(agentId, {
      format: "jpeg",
      quality: 60,
    })
  } catch {
    return null
  }
}

async function persistScreenshot(
  db: Kysely<Database>,
  agentId: string,
  pageUrl: string,
  pageTitle: string,
  screenshot: {
    data: string
    format: "jpeg" | "png"
    width: number
    height: number
    timestamp: string
    url: string
    title: string
  },
): Promise<void> {
  const mimeType = screenshot.format === "png" ? "image/png" : "image/jpeg"
  const dataUrl = `data:${mimeType};base64,${screenshot.data}`

  await db
    .insertInto("browser_screenshot")
    .values({
      id: randomUUID(),
      agent_id: agentId,
      thumbnail_url: dataUrl,
      full_url: dataUrl,
      width: screenshot.width,
      height: screenshot.height,
    })
    .execute()

  await db
    .insertInto("browser_event")
    .values({
      agent_id: agentId,
      type: "SNAPSHOT",
      url: pageUrl,
      selector: null,
      message: `Captured screenshot for ${pageTitle || pageUrl}`,
      duration_ms: null,
      severity: "info",
    })
    .execute()
}
