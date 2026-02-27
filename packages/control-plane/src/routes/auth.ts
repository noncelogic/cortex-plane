/**
 * Auth Routes — OAuth login, callback, session, and logout.
 *
 * Endpoints:
 *   GET  /auth/providers         — list configured OAuth providers
 *   GET  /auth/login/:provider   — initiate OAuth login (redirect)
 *   GET  /auth/callback/:provider — OAuth callback handler
 *   GET  /auth/session           — get current session user
 *   POST /auth/logout            — destroy session
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import { discoverAntigravityProject } from "../auth/antigravity-project.js"
import type { CredentialService } from "../auth/credential-service.js"
import {
  buildAuthorizeUrl,
  decodeOAuthState,
  encodeOAuthState,
  exchangeCodeForTokens,
  fetchUserProfile,
  generateCodeChallenge,
  generateCodeVerifier,
  type OAuthState,
} from "../auth/oauth-service.js"
import { getCodePasteProvider, listCodePasteProviders } from "../auth/oauth-providers.js"
import { parseAuthorizationInput } from "../auth/parse-authorization-input.js"
import { findOrCreateOAuthUser, SessionService } from "../auth/session-service.js"
import type { AuthOAuthConfig, OAuthProviderConfig } from "../config.js"
import type { Database } from "../db/types.js"
import { createRequireAuth, type PreHandler } from "../middleware/auth.js"
import type { AuthenticatedRequest } from "../middleware/types.js"

// In-memory store for PKCE verifiers (keyed by state nonce).
// In production, use Redis or DB. For single-instance deployments this is fine.
const pendingPkceVerifiers = new Map<string, string>()

interface AuthRouteDeps {
  db: Kysely<Database>
  authConfig: AuthOAuthConfig
  sessionService: SessionService
  credentialService: CredentialService
}

export function authRoutes(deps: AuthRouteDeps) {
  const { db, authConfig, sessionService, credentialService } = deps

  return function register(app: FastifyInstance): void {
    const isSecure = authConfig.dashboardUrl.startsWith("https")
    const requireAuth: PreHandler = createRequireAuth({
      config: { apiKeys: [], requireAuth: true },
      sessionService,
    })

    /**
     * GET /auth/providers — list configured login providers
     */
    app.get("/auth/providers", () => {
      const providers: { id: string; name: string; enabled: boolean }[] = []
      if (authConfig.google) {
        providers.push({ id: "google", name: "Google", enabled: true })
      }
      if (authConfig.github) {
        providers.push({ id: "github", name: "GitHub", enabled: true })
      }
      return { providers }
    })

    /**
     * GET /auth/login/:provider — redirect to OAuth provider
     */
    app.get<{ Params: { provider: string } }>(
      "/auth/login/:provider",
      async (request: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
        const { provider } = request.params
        const providerConfig = getLoginProviderConfig(provider, authConfig)
        if (!providerConfig) {
          reply
            .status(400)
            .send({ error: "bad_request", message: `Provider '${provider}' not configured` })
          return
        }

        const nonce = crypto.randomUUID()
        const state: OAuthState = { nonce, provider, flow: "login" }
        const encodedState = encodeOAuthState(state, authConfig.credentialMasterKey)

        const callbackUrl = `${authConfig.dashboardUrl}/api/auth/callback/${provider}`

        const authUrl = buildAuthorizeUrl({
          provider,
          config: providerConfig,
          callbackUrl,
          state: encodedState,
        })

        reply.redirect(authUrl)
      },
    )

    /**
     * GET /auth/callback/:provider — handle OAuth callback
     */
    app.get<{
      Params: { provider: string }
      Querystring: { code?: string; state?: string; error?: string }
    }>(
      "/auth/callback/:provider",
      async (
        request: FastifyRequest<{
          Params: { provider: string }
          Querystring: { code?: string; state?: string; error?: string }
        }>,
        reply: FastifyReply,
      ) => {
        const { provider } = request.params
        const { code, state: stateParam, error } = request.query

        if (error) {
          reply.redirect(`${authConfig.dashboardUrl}/login?error=${encodeURIComponent(error)}`)
          return
        }

        if (!code || !stateParam) {
          reply.redirect(`${authConfig.dashboardUrl}/login?error=missing_params`)
          return
        }

        // Validate state parameter (CSRF protection)
        const oauthState = decodeOAuthState(stateParam, authConfig.credentialMasterKey)
        if (!oauthState || oauthState.provider !== provider) {
          reply.redirect(`${authConfig.dashboardUrl}/login?error=invalid_state`)
          return
        }

        const providerConfig = getLoginProviderConfig(provider, authConfig)
        if (!providerConfig) {
          reply.redirect(`${authConfig.dashboardUrl}/login?error=provider_not_configured`)
          return
        }

        const callbackUrl = `${authConfig.dashboardUrl}/api/auth/callback/${provider}`

        try {
          // Exchange code for tokens
          const codeVerifier = oauthState.codeVerifier ?? pendingPkceVerifiers.get(oauthState.nonce)
          if (codeVerifier) pendingPkceVerifiers.delete(oauthState.nonce)

          const tokens = await exchangeCodeForTokens({
            provider,
            config: providerConfig,
            code,
            callbackUrl,
            codeVerifier,
          })

          // Fetch user profile
          const profile = await fetchUserProfile(provider, tokens.access_token)

          // Find or create user
          const user = await findOrCreateOAuthUser(db, {
            provider,
            providerId: profile.providerId,
            email: profile.email,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
          })

          // Audit log
          await db
            .insertInto("credential_audit_log")
            .values({
              user_account_id: user.id,
              event_type: "login",
              provider,
              details: { method: "oauth", ip: request.ip },
              ip_address: request.ip,
            })
            .execute()

          // Create session
          const session = await sessionService.createSession(user.id)

          // Set httpOnly session cookie
          const cookie = SessionService.serializeCookie(
            session.sessionId,
            authConfig.sessionMaxAge,
            isSecure,
          )
          reply.header("Set-Cookie", cookie)

          // Redirect to dashboard with CSRF token as URL param (dashboard stores it in memory)
          reply.redirect(`${authConfig.dashboardUrl}/auth/complete?csrf=${session.csrfToken}`)
        } catch (err) {
          request.log.error(err, `OAuth callback error for provider ${provider}`)
          reply.redirect(`${authConfig.dashboardUrl}/login?error=auth_failed`)
        }
      },
    )

    /**
     * GET /auth/session — get current session info (no secrets)
     */
    app.get(
      "/auth/session",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized", message: "Not authenticated" })
          return
        }

        let avatarUrl = principal.avatarUrl ?? null
        if (principal.authMethod === "session") {
          const sessionId = SessionService.parseSessionCookie(request.headers.cookie)
          if (sessionId) {
            const sessionData = await sessionService.validateSession(sessionId)
            avatarUrl = sessionData?.user.avatarUrl ?? avatarUrl
          }
        }

        return {
          userId: principal.userId,
          displayName: principal.displayName,
          email: principal.email ?? null,
          avatarUrl,
          role: principal.userRole ?? null,
          authMethod: principal.authMethod,
        }
      },
    )

    /**
     * POST /auth/logout — destroy session
     */
    app.post(
      "/auth/logout",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (principal?.authMethod === "session") {
          const cookieHeader = request.headers.cookie
          const sessionId = SessionService.parseSessionCookie(cookieHeader)
          if (sessionId) {
            await sessionService.deleteSession(sessionId)

            await db
              .insertInto("credential_audit_log")
              .values({
                user_account_id: principal.userId,
                event_type: "logout",
                details: { ip: request.ip },
                ip_address: request.ip,
              })
              .execute()
          }
        }

        const cookie = SessionService.clearCookie(isSecure)
        reply.header("Set-Cookie", cookie)
        return { ok: true }
      },
    )

    /**
     * GET /auth/connect/:provider — initiate LLM provider OAuth (PKCE)
     * Requires an authenticated session.
     */
    app.get<{ Params: { provider: string } }>(
      "/auth/connect/:provider",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { provider } = request.params
        const providerConfig = getConnectProviderConfig(provider, authConfig)
        if (!providerConfig) {
          reply.status(400).send({
            error: "bad_request",
            message: `Provider '${provider}' not configured for connection`,
          })
          return
        }

        const nonce = crypto.randomUUID()
        const codeVerifier = generateCodeVerifier()
        const codeChallenge = generateCodeChallenge(codeVerifier)

        // Store verifier keyed by nonce (retrieved in callback)
        pendingPkceVerifiers.set(nonce, codeVerifier)
        // Expire after 10 minutes
        setTimeout(() => pendingPkceVerifiers.delete(nonce), 10 * 60 * 1000)

        const state: OAuthState = { nonce, provider, flow: "connect" }
        const encodedState = encodeOAuthState(state, authConfig.credentialMasterKey)

        const callbackUrl = `${authConfig.dashboardUrl}/api/auth/connect/callback/${provider}`

        const authUrl = buildAuthorizeUrl({
          provider,
          config: providerConfig,
          callbackUrl,
          state: encodedState,
          codeChallenge,
        })

        reply.redirect(authUrl)
      },
    )

    /**
     * GET /auth/connect/callback/:provider — handle LLM provider OAuth callback
     */
    app.get<{
      Params: { provider: string }
      Querystring: { code?: string; state?: string; error?: string }
    }>(
      "/auth/connect/callback/:provider",
      async (
        request: FastifyRequest<{
          Params: { provider: string }
          Querystring: { code?: string; state?: string; error?: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.redirect(`${authConfig.dashboardUrl}/login?error=not_authenticated`)
          return
        }

        const { provider } = request.params
        const { code, state: stateParam, error } = request.query

        if (error || !code || !stateParam) {
          reply.redirect(
            `${authConfig.dashboardUrl}/settings?error=${encodeURIComponent(error ?? "missing_params")}`,
          )
          return
        }

        const oauthState = decodeOAuthState(stateParam, authConfig.credentialMasterKey)
        if (!oauthState || oauthState.provider !== provider || oauthState.flow !== "connect") {
          reply.redirect(`${authConfig.dashboardUrl}/settings?error=invalid_state`)
          return
        }

        const providerConfig = getConnectProviderConfig(provider, authConfig)
        if (!providerConfig) {
          reply.redirect(`${authConfig.dashboardUrl}/settings?error=provider_not_configured`)
          return
        }

        const callbackUrl = `${authConfig.dashboardUrl}/api/auth/connect/callback/${provider}`

        try {
          const codeVerifier = pendingPkceVerifiers.get(oauthState.nonce)
          if (codeVerifier) pendingPkceVerifiers.delete(oauthState.nonce)

          const tokens = await exchangeCodeForTokens({
            provider,
            config: providerConfig,
            code,
            callbackUrl,
            codeVerifier,
          })

          await credentialService.storeOAuthCredential(principal.userId, provider, tokens)

          reply.redirect(`${authConfig.dashboardUrl}/settings?connected=${provider}`)
        } catch (err) {
          request.log.error(err, `Provider connect error for ${provider}`)
          reply.redirect(`${authConfig.dashboardUrl}/settings?error=connect_failed`)
        }
      },
    )

    // -----------------------------------------------------------------------
    // Code-paste flow endpoints
    // -----------------------------------------------------------------------

    /**
     * GET /auth/connect/:provider/init — generate PKCE challenge and OAuth URL
     * for the code-paste flow. Returns { authUrl, codeVerifier } as JSON.
     */
    app.get<{ Params: { provider: string } }>(
      "/auth/connect/:provider/init",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { provider } = request.params
        const providerReg = getCodePasteProvider(provider)
        if (!providerReg) {
          reply.status(400).send({
            error: "bad_request",
            message: `Provider '${provider}' is not available for code-paste connection`,
          })
          return
        }

        const codeVerifier = generateCodeVerifier()
        const codeChallenge = generateCodeChallenge(codeVerifier)

        const url = new URL(providerReg.authUrl)
        url.searchParams.set("client_id", providerReg.clientId)
        url.searchParams.set("redirect_uri", providerReg.redirectUri)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("scope", providerReg.scopes.join(" "))

        if (providerReg.usePkce) {
          url.searchParams.set("code_challenge", codeChallenge)
          url.searchParams.set("code_challenge_method", "S256")
        }

        if (providerReg.extraAuthParams) {
          for (const [key, value] of Object.entries(providerReg.extraAuthParams)) {
            url.searchParams.set(key, value)
          }
        }

        return { authUrl: url.toString(), codeVerifier }
      },
    )

    /**
     * POST /auth/connect/:provider/exchange — accept pasted URL and exchange
     * authorization code for tokens.
     */
    app.post<{
      Params: { provider: string }
      Body: { pastedUrl: string; codeVerifier: string }
    }>(
      "/auth/connect/:provider/exchange",
      { preHandler: [requireAuth] },
      async (
        request: FastifyRequest<{
          Params: { provider: string }
          Body: { pastedUrl: string; codeVerifier: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { provider } = request.params
        const { pastedUrl, codeVerifier } = request.body

        if (!pastedUrl || !codeVerifier) {
          reply.status(400).send({
            error: "bad_request",
            message: "pastedUrl and codeVerifier are required",
          })
          return
        }

        const providerReg = getCodePasteProvider(provider)
        if (!providerReg) {
          reply.status(400).send({
            error: "bad_request",
            message: `Provider '${provider}' is not available for code-paste connection`,
          })
          return
        }

        // Parse the pasted input to extract the authorization code
        const parsed = parseAuthorizationInput(pastedUrl, provider)
        if (!parsed) {
          reply.status(400).send({
            error: "bad_request",
            message: "Could not extract authorization code from pasted input",
          })
          return
        }

        try {
          const providerConfig: OAuthProviderConfig = {
            clientId: providerReg.clientId,
            clientSecret: providerReg.clientSecret,
            authUrl: providerReg.authUrl,
            tokenUrl: providerReg.tokenUrl,
          }

          const tokens = await exchangeCodeForTokens({
            provider,
            config: providerConfig,
            code: parsed.code,
            callbackUrl: providerReg.redirectUri,
            codeVerifier,
          })

          // Provider-specific post-exchange actions
          let accountId: string | undefined
          if (provider === "google-antigravity") {
            accountId = await discoverAntigravityProject(tokens.access_token)
          }

          await credentialService.storeOAuthCredential(principal.userId, provider, tokens, {
            accountId,
            scopes: providerReg.scopes,
          })

          return {
            ok: true,
            provider: providerReg.name,
            accountId: accountId ?? null,
          }
        } catch (err) {
          request.log.error(err, `Code-paste exchange error for ${provider}`)
          reply.status(500).send({
            error: "exchange_failed",
            message: err instanceof Error ? err.message : "Failed to exchange authorization code",
          })
        }
      },
    )
  }
}

function getLoginProviderConfig(
  provider: string,
  authConfig: AuthOAuthConfig,
): OAuthProviderConfig | undefined {
  switch (provider) {
    case "google":
      return authConfig.google
    case "github":
      return authConfig.github
    default:
      return undefined
  }
}

function getConnectProviderConfig(
  provider: string,
  authConfig: AuthOAuthConfig,
): OAuthProviderConfig | undefined {
  switch (provider) {
    case "google-antigravity":
      return authConfig.googleAntigravity
    case "openai-codex":
      return authConfig.openaiCodex
    default:
      return undefined
  }
}
