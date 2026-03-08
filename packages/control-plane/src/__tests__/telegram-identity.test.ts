import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchTelegramBotIdentity } from "../channels/telegram-identity.js"

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

afterEach(() => {
  mockFetch.mockReset()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchTelegramBotIdentity", () => {
  it("returns bot metadata on successful getMe response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          result: {
            id: 987654321,
            is_bot: true,
            first_name: "Test Bot",
            username: "test_bot",
          },
        }),
    })

    const result = await fetchTelegramBotIdentity("123:ABC")

    expect(result).toEqual({
      bot_id: "987654321",
      username: "test_bot",
      display_name: "Test Bot",
    })
    expect(mockFetch).toHaveBeenCalledWith("https://api.telegram.org/bot123:ABC/getMe")
  })

  it("returns undefined when the Telegram API returns ok: false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: false,
          description: "Unauthorized",
        }),
    })

    const result = await fetchTelegramBotIdentity("invalid-token")

    expect(result).toBeUndefined()
  })

  it("returns undefined when the HTTP response is not ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    const result = await fetchTelegramBotIdentity("bad-token")

    expect(result).toBeUndefined()
  })

  it("returns undefined when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"))

    const result = await fetchTelegramBotIdentity("any-token")

    expect(result).toBeUndefined()
  })

  it("handles bot without username field", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          result: {
            id: 111,
            is_bot: true,
            first_name: "No Username Bot",
          },
        }),
    })

    const result = await fetchTelegramBotIdentity("tok")

    expect(result).toEqual({
      bot_id: "111",
      username: "",
      display_name: "No Username Bot",
    })
  })
})
