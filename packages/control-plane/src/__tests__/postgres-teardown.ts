import type pg from "pg"

export function isExpectedTeardownPgError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const maybe = err as { code?: string; message?: string }
  const msg = (maybe.message ?? "").toLowerCase()
  return (
    maybe.code === "57P01" ||
    msg.includes("terminating connection due to administrator command") ||
    msg.includes("connection terminated unexpectedly")
  )
}

export function attachPoolErrorHandler(pool: pg.Pool): () => void {
  const handler = (err: Error) => {
    if (isExpectedTeardownPgError(err)) return
    console.error("[test] unexpected pg pool error", err)
  }
  pool.on("error", handler)
  return () => {
    pool.off("error", handler)
  }
}

export async function endPoolGracefully(pool: pg.Pool, timeoutMs = 8_000): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id)
      reject(new Error(`pool.end() timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    await Promise.race([pool.end(), timeout])
  } catch (err) {
    if (isExpectedTeardownPgError(err)) return
    throw err
  }
}
