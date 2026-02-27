import { type NextRequest, NextResponse } from "next/server"

const CONTROL_PLANE_URL = process.env.CORTEX_API_URL ?? "http://localhost:4000"

export const dynamic = "force-dynamic"

async function proxyRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params
  const targetPath = `/${path.join("/")}`
  const url = new URL(targetPath, CONTROL_PLANE_URL)

  // Forward query string
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  // Forward headers (except host)
  const headers = new Headers(request.headers)
  headers.delete("host")

  const init: RequestInit = {
    method: request.method,
    headers,
  }

  // Forward body for non-GET/HEAD requests
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body
    ;(init as Record<string, unknown>).duplex = "half"
  }

  const upstream = await fetch(url.toString(), init)

  // Stream the response back
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete("transfer-encoding")

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const DELETE = proxyRequest
export const PATCH = proxyRequest
