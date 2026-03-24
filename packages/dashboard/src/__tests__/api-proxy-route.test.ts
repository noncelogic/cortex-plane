import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { GET, POST } from "@/app/api/[...path]/route"

describe("dashboard API proxy browser auth propagation", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("forwards dashboard session cookies on browser observation GET routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const request = new NextRequest(
      "http://dashboard.local/api/agents/agent-1/observe/stream-status",
      {
        headers: {
          cookie: "cortex_session=dash-session-1; other=value",
        },
      },
    )

    const response = await GET(request, {
      params: Promise.resolve({ path: ["agents", "agent-1", "observe", "stream-status"] }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:4000/agents/agent-1/observe/stream-status")
    expect(new Headers(init.headers).get("cookie")).toContain("cortex_session=dash-session-1")
  })

  it("forwards bearer auth and request bodies on browser routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const request = new NextRequest(
      "http://dashboard.local/api/agents/agent-1/browser/steer?source=dashboard",
      {
        method: "POST",
        headers: {
          authorization: "Bearer session-123",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "click",
          coordinates: { x: 1, y: 2 },
        }),
      },
    )

    const response = await POST(request, {
      params: Promise.resolve({ path: ["agents", "agent-1", "browser", "steer"] }),
    })

    expect(response.status).toBe(202)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:4000/agents/agent-1/browser/steer?source=dashboard")
    expect(init.method).toBe("POST")
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer session-123")

    const forwardedBody = await new Response(init.body as BodyInit).text()
    expect(JSON.parse(forwardedBody)).toEqual({
      type: "click",
      coordinates: { x: 1, y: 2 },
    })
  })
})
