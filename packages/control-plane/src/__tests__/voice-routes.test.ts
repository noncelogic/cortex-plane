import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import { voiceRoutes } from "../routes/voice.js"
import type { VoiceSignalingBackendInput } from "../routes/voice-signaling.js"

const VALID_SESSION = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user_account_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  status: "active",
}

function buildMockDb(options?: {
  session?: typeof VALID_SESSION | null
  agentExists?: boolean
}): Kysely<Database> {
  const sessionRow = options?.session === undefined ? VALID_SESSION : options.session
  const agentExists = options?.agentExists ?? true

  const selectFrom = vi.fn().mockImplementation((table: string) => {
    if (table === "session") {
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(sessionRow),
            }),
          }),
        }),
      }
    }

    if (table === "agent") {
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi
              .fn()
              .mockResolvedValue(agentExists ? { id: VALID_SESSION.agent_id } : null),
          }),
        }),
      }
    }

    throw new Error(`Unexpected table in mock: ${table}`)
  })

  return { selectFrom } as unknown as Kysely<Database>
}

describe("voice routes", () => {
  it("POST /voice/webrtc-offer performs mocked SDP exchange and binds to bearer session", async () => {
    const db = buildMockDb()
    /* eslint-disable @typescript-eslint/require-await */
    const backendExchange = vi.fn(
      async (
        input: VoiceSignalingBackendInput,
      ): Promise<{ answerSdp: string; iceServers: Array<{ urls: string[] }> }> => {
        expect(input.agentId).toBe(VALID_SESSION.agent_id)
        expect(input.boundSessionId).toBe(VALID_SESSION.id)
        expect(input.userAccountId).toBe(VALID_SESSION.user_account_id)
        expect(input.ephemeralToken).toContain("cortex_vc_1_")
        expect(input.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now())
        return {
          answerSdp: "v=0\r\ns=mock-answer\r\nt=0 0\r\n",
          iceServers: [{ urls: ["stun:stun.example.net:3478"] }],
        }
      },
    )
    /* eslint-enable @typescript-eslint/require-await */

    const app = Fastify({ logger: false })
    await app.register(
      voiceRoutes({
        db,
        signalingBackend: { exchangeOffer: backendExchange },
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: "/voice/webrtc-offer",
      headers: { authorization: `Bearer ${VALID_SESSION.id}` },
      payload: {
        agentId: VALID_SESSION.agent_id,
        sdp: "v=0\r\na=setup:actpass\r\n",
      },
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.sessionId).toBeTypeOf("string")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.sdp).toBe("v=0\r\ns=mock-answer\r\nt=0 0\r\n")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.iceServers[0].urls[0]).toBe("stun:stun.example.net:3478")
    expect(backendExchange).toHaveBeenCalledTimes(1)
  })

  it("returns 403 when bearer session does not match requested agentId", async () => {
    const db = buildMockDb()
    const app = Fastify({ logger: false })

    await app.register(voiceRoutes({ db }))

    const res = await app.inject({
      method: "POST",
      url: "/voice/webrtc-offer",
      headers: { authorization: `Bearer ${VALID_SESSION.id}` },
      payload: {
        agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sdp: "v=0\r\n",
      },
    })

    expect(res.statusCode).toBe(403)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().error).toBe("forbidden")
  })
})
