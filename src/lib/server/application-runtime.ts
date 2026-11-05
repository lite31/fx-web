import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createDpopReplayStore } from "better-auth/oauth2";
import { getMigrations } from "better-auth/db/migration";
import { username } from "better-auth/plugins/username";
import { jwt } from "better-auth/plugins/jwt";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { z } from "zod";
import { createClientMetadata } from "./mcp-metadata.ts";
import { ApiError, expectedUserHeader } from "../contract.ts";
import { createCommerce, openDatabase, type Identity, type DelegatedIdentity } from "./commerce.ts";
import { createChatHistory } from "./chat-history.ts";
import { loopbackHosts } from "./http.ts";

export async function createRuntime({
  path,
  secret,
  baseURL,
  approvedClientMetadataUrls = [],
}: {
  path: string;
  secret: string | undefined;
  baseURL: string;
  approvedClientMetadataUrls?: readonly string[];
}) {
  if (!secret || secret.length < 32)
    throw new Error("Set BETTER_AUTH_SECRET with task auth-setup before starting the server.");
  const db = openDatabase(path);
  try {
    const origin = new URL(baseURL);
    const trustedOrigins = loopbackHosts.map((hostname) => {
      const allowed = new URL(origin.origin);
      allowed.hostname = hostname;
      return allowed.origin;
    });
    const metadata = createClientMetadata(approvedClientMetadataUrls);
    const resource = new URL("/mcp", origin).href;
    const options = {
      database: db,
      secret,
      baseURL,
      trustedOrigins,
      rateLimit: { enabled: true },
      advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } },
      user: { modelName: "users" },
      // A cached session cookie would keep a revoked session usable until it expires.
      session: { modelName: "sessions", cookieCache: { enabled: false } },
      emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
      plugins: [
        jwt(),
        mcp({
          resource,
          loginPage: "/oauth/sign-in",
          consentPage: "/oauth/consent",
          scopes: ["shop:read", "shop:write", "offline_access"],
          grantTypes: ["authorization_code", "refresh_token"],
          accessTokenExpiresIn: 300,
          // The provider does not treat `sub` as the Better Auth user ID, so tokens carry it here.
          customAccessTokenClaims: ({ user }) => (user ? { fx_native_user_id: user.id } : {}),
        }),
        cimd({
          metadataProfile: "mcp-2026-07-28",
          isMetadataDocumentUrlAllowed: (url) => approvedClientMetadataUrls.includes(url),
          fetchClientMetadataResource: metadata.fetch,
        }),
        username({
          minUsernameLength: 3,
          maxUsernameLength: 64,
          usernameValidator: (value) => /^[a-z0-9_.-]+$/.test(value),
          usernameNormalization: (value) => value.trim().toLowerCase(),
          validationOrder: { username: "post-normalization" },
          displayUsername: false,
        }),
      ],
    } satisfies BetterAuthOptions;
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
    const auth = betterAuth(options);
    const commerce = createCommerce(db);
    const chatHistory = createChatHistory(db);
    // Better Auth can await inside a transaction on this same SQLite connection.
    // Queue auth, commerce, history, and replay reservations to prevent overlapping
    // transactions. Queued work must not await another operation on this queue.
    let pending: Promise<unknown> = Promise.resolve();
    function withDatabase<T>(work: () => T | Promise<T>): Promise<T> {
      const result = pending.catch(() => {}).then(work);
      pending = result;
      return result;
    }
    async function freshIdentity(headers: Headers): Promise<Identity | null> {
      const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
      return session ? { userId: session.user.id, sessionId: session.session.id } : null;
    }
    const replayStore = createDpopReplayStore((await auth.$context).internalAdapter);
    const sessionCleanup = new Set<(identity: Identity | null) => void>();
    const claimsSchema = z.object({
      iss: z.string().min(1),
      sub: z.string().min(1),
      sid: z.string().min(1),
      client_id: z.string().min(1),
      exp: z.number().int(),
      scope: z.string(),
      fx_native_user_id: z.string().min(1),
    });
    return {
      commerce,
      chatHistory,
      resource,
      protectMcp: (handler: (request: Request, identity: DelegatedIdentity) => Promise<Response>) =>
        requireMcpAuth(
          auth,
          (request, rawClaims) => {
            const parsed = claimsSchema.safeParse(rawClaims);
            if (!parsed.success)
              return Response.json(
                { error: "A session-bound authorization is required." },
                { status: 401 },
              );
            const claims = parsed.data;
            return handler(request, {
              userId: claims.fx_native_user_id,
              sessionId: claims.sid,
              delegation: {
                expiresAt: claims.exp * 1000,
                scopes: claims.scope.split(" ").filter(Boolean),
              },
            });
          },
          {
            resource,
            challengeScopes: ["shop:read", "shop:write"],
            dpop: {
              replayStore: {
                reserve: (reservation) => withDatabase(() => replayStore.reserve(reservation)),
              },
            },
          },
        ),
      operation: <T>(work: () => T) => withDatabase(work),
      onSessionEnd: (cleanup: (identity: Identity | null) => void) => {
        sessionCleanup.add(cleanup);
        return () => sessionCleanup.delete(cleanup);
      },
      handle: async (request: Request) => {
        try {
          // Fetch approved client metadata before taking the database queue. The
          // auth plugin later reads the prepared cache without waiting on the network.
          await metadata.prepare(request);
        } catch {
          return Response.json(
            { error: "Client metadata is unavailable or not approved." },
            { status: 400 },
          );
        }
        return withDatabase(async () => {
          // Sign-out also requires the expected-user header, so a stale tab cannot end the
          // new account's session. A successful sign-out then closes that session's MCP work.
          let endingSession: Identity | null = null;
          if (new URL(request.url).pathname === "/api/auth/sign-out") {
            const identity = await freshIdentity(request.headers);
            endingSession = identity;
            if (!identity || identity.userId !== request.headers.get(expectedUserHeader))
              return Response.json({ error: "Sign in to continue." }, { status: 401 });
          }
          const response = await auth.handler(request);
          if (response.ok && endingSession)
            for (const cleanup of sessionCleanup) cleanup(endingSession);
          return response;
        });
      },
      authorized: <T>(headers: Headers, work: (identity: Identity) => T) =>
        withDatabase(async () => {
          const identity = await freshIdentity(headers);
          if (!identity || identity.userId !== headers.get(expectedUserHeader))
            throw new ApiError("Sign in to continue.", 401);
          return work(identity);
        }),
      close: () =>
        withDatabase(() => {
          for (const cleanup of sessionCleanup) cleanup(null);
          sessionCleanup.clear();
          db.close();
        }),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
