import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createRuntime, type Runtime } from "../src/lib/server/application-runtime.ts";
import { api } from "../src/lib/server/api.ts";
import { mcpHttp, isMcpProtocolPath } from "../src/lib/server/mcp-provider.ts";
import { boundedMetadata } from "../src/lib/server/mcp-metadata.ts";
import { cartSchema, catalogSchema } from "../src/lib/contract.ts";
import { fixtureProducts, sessionIdentity, testSecret } from "./fixture.ts";

const accountSchema = z.object({ user: z.object({ id: z.string() }) });
const tokensSchema = z.object({ access_token: z.string(), refresh_token: z.string() });
const claimsSchema = z.looseObject({
  iss: z.string(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sid: z.string(),
  client_id: z.string(),
  exp: z.number(),
  scope: z.string(),
  fx_native_user_id: z.string(),
});
const decode = (token: string) =>
  claimsSchema.parse(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()));
const cookieFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
let fixtureNumber = 100;

async function providerFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "fx-mcp-provider-"));
  const path = join(directory, "shop.sqlite");
  const clients: Client[] = [];
  const address = `192.0.2.${++fixtureNumber}`;
  let runtime: Runtime | undefined;
  const server = createServer(async (incoming, outgoing) => {
    try {
      assert.ok(runtime);
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      headers.set("x-real-ip", address);
      const request = new Request(origin + incoming.url, {
        method: incoming.method,
        headers,
        ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
          ? {}
          : { body: Buffer.concat(chunks) }),
      });
      const response = isMcpProtocolPath(new URL(request.url).pathname)
        ? await mcpHttp.fetch(request, { runtime })
        : await api.fetch(request, { runtime, model: "fixture", gatewayKey: "fixture-only" });
      outgoing.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        ...(response.headers.has("set-cookie")
          ? { "set-cookie": response.headers.getSetCookie() }
          : {}),
      });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const origin = `http://127.0.0.1:${bound.port}`;
  runtime = await createRuntime({ path, secret: testSecret, baseURL: origin });
  runtime.commerce.importCatalog(fixtureProducts);
  const activeRuntime = runtime;
  t.after(async () => {
    for (const client of clients) await client.close();
    await activeRuntime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function native(pathname: string, body: unknown, cookie = "", userId = "") {
    return fetch(origin + "/api/" + pathname, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json", "x-fx-user-id": userId },
      body: JSON.stringify(body),
    });
  }
  async function account(name: string) {
    const response = await native("auth/sign-up/email", {
      username: name,
      name,
      email: name + "@example.com",
      password: "provider-fixture-password",
    });
    assert.equal(response.status, 200, await response.clone().text());
    const userId = accountSchema.parse(await response.json()).user.id;
    const cookie = cookieFrom(response);
    const identity = await sessionIdentity(activeRuntime, new Headers({ cookie }));
    assert.ok(identity);
    return { cookie, userId, identity };
  }
  async function beginGrant(
    who: Awaited<ReturnType<typeof account>>,
    scope = "shop:read shop:write offline_access",
  ) {
    const created = await native(
      "auth/oauth2/create-client",
      {
        client_name: "Reference SDK host",
        application_type: "native",
        redirect_uris: [origin + "/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope,
      },
      who.cookie,
      who.userId,
    );
    assert.equal(created.status, 201, await created.clone().text());
    const { client_id } = z.object({ client_id: z.string() }).parse(await created.json());
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id,
      redirect_uri: origin + "/callback",
      response_type: "code",
      scope,
      resource: activeRuntime.resource,
      state: "fixture-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorize = await fetch(origin + "/api/auth/oauth2/authorize?" + query, {
      headers: { cookie: who.cookie, accept: "application/json" },
      redirect: "manual",
    });
    assert.equal(authorize.status, 200, await authorize.clone().text());
    const authorization = z.object({ url: z.string() }).parse(await authorize.json());
    const consentUrl = new URL(authorization.url, origin);
    assert.equal(consentUrl.pathname, "/oauth/consent");
    const consent = await native(
      "auth/oauth2/consent",
      {
        accept: true,
        oauth_query: consentUrl.searchParams.toString(),
      },
      who.cookie,
      who.userId,
    );
    assert.equal(consent.status, 200, await consent.clone().text());
    const { url } = z.object({ url: z.string() }).parse(await consent.json());
    const callback = new URL(url);
    assert.equal(callback.searchParams.get("state"), "fixture-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);
    async function token(body: Record<string, string>) {
      return fetch(origin + "/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id, resource: activeRuntime.resource, ...body }),
      });
    }
    const exchange = (codeVerifier = verifier) =>
      token({
        grant_type: "authorization_code",
        redirect_uri: origin + "/callback",
        code,
        code_verifier: codeVerifier,
      });
    return { client_id, token, exchange };
  }
  async function grant(who: Awaited<ReturnType<typeof account>>, scope?: string) {
    const authorization = await beginGrant(who, scope);
    const exchanged = await authorization.exchange();
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    return { ...tokensSchema.parse(await exchanged.json()), ...authorization };
  }
  async function client(token: string, legacy = false) {
    const value = new Client(
      { name: "fx-web-acceptance", version: "1" },
      {
        ...(legacy ? { supportedProtocolVersions: ["2025-06-18"] } : {}),
        versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } },
      },
    );
    clients.push(value);
    await value.connect(
      new StreamableHTTPClientTransport(new URL(activeRuntime.resource), {
        requestInit: { headers: { authorization: "Bearer " + token } },
      }),
    );
    return value;
  }
  return { origin, path, runtime: activeRuntime, native, account, grant, beginGrant, client };
}

test("external MCP uses real PKCE grants and refresh, shares authoritative carts, rejects stale writes and loses access on logout", async (t) => {
  const s = await providerFixture(t);
  const challenge = await fetch(s.runtime.resource);
  assert.equal(challenge.status, 401);
  const metadataUrl = challenge.headers
    .get("www-authenticate")
    ?.match(/resource_metadata="([^"]+)"/)?.[1];
  assert.ok(metadataUrl);
  const protectedResponse = await fetch(metadataUrl);
  assert.equal(protectedResponse.status, 200);
  const protectedMetadata = z
    .object({ resource: z.url(), authorization_servers: z.array(z.url()) })
    .parse(await protectedResponse.json());
  assert.equal(protectedMetadata.resource, s.runtime.resource);
  assert.deepEqual(protectedMetadata.authorization_servers, [s.origin + "/api/auth"]);
  const discovered = await fetch(s.origin + "/.well-known/oauth-authorization-server/api/auth");
  assert.equal(discovered.status, 200);
  const serverMetadata = z
    .object({ issuer: z.url(), token_endpoint: z.url() })
    .parse(await discovered.json());
  assert.equal(serverMetadata.issuer, s.origin + "/api/auth");
  assert.equal(serverMetadata.token_endpoint, s.origin + "/api/auth/oauth2/token");
  const alice = await s.account("mcp_alice");
  const bob = await s.account("mcp_bob");
  const grant = await s.grant(alice);
  const issued = decode(grant.access_token);
  assert.equal(issued.sid, alice.identity.sessionId);
  assert.equal(issued.fx_native_user_id, alice.userId);
  assert.ok([issued.aud].flat().includes(s.runtime.resource));
  const refreshed = await grant.token({
    grant_type: "refresh_token",
    refresh_token: grant.refresh_token,
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const renewed = tokensSchema.parse(await refreshed.json());
  assert.equal(decode(renewed.access_token).sid, alice.identity.sessionId);
  assert.equal(decode(renewed.access_token).fx_native_user_id, alice.userId);
  const client = await s.client(renewed.access_token);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    "get_cart",
    "list_products",
    "set_cart_quantity",
  ]);
  const resource = await client.readResource({ uri: "ui://fx-web/shop" });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok("text" in resource.contents[0] && resource.contents[0].text.length > 1000);
  const listed = await client.callTool({ name: "list_products", arguments: {} });
  const listing = z
    .object({ catalog: catalogSchema, cart: cartSchema })
    .parse(listed.structuredContent);
  const catalog = listing.catalog;
  assert.equal(listing.cart.count, 0);
  const filtered = await client.callTool({
    name: "list_products",
    arguments: { query: " COFFEE " },
  });
  const matching = z
    .object({ catalog: catalogSchema, cart: cartSchema })
    .parse(filtered.structuredContent);
  assert.deepEqual(
    matching.catalog.products.map((product) => product.id),
    ["coffee"],
  );
  assert.deepEqual(matching.cart, listing.cart);
  assert.equal(catalog.products.find((product) => product.id === "coffee")?.priceCents, 500);
  const changed = await client.callTool({
    name: "set_cart_quantity",
    arguments: { product_id: "coffee", quantity: 2, expectedRevision: 0 },
  });
  const mutation = z
    .object({ catalog: catalogSchema, cart: cartSchema })
    .parse(changed.structuredContent);
  assert.deepEqual(mutation.catalog, catalog);
  const changedCart = mutation.cart;
  assert.equal(changedCart.totalCents, 1000);
  assert.equal(s.runtime.commerce.cart(alice.userId).count, 2);
  assert.equal(s.runtime.commerce.cart(bob.userId).count, 0);
  const native = await s.native(
    "cart/quantity",
    {
      product_id: "coffee",
      quantity: 3,
      expectedRevision: changedCart.revision,
    },
    alice.cookie,
    alice.userId,
  );
  assert.equal(native.status, 200);
  const stale = await client.callTool({
    name: "set_cart_quantity",
    arguments: { product_id: "coffee", quantity: 1, expectedRevision: changedCart.revision },
  });
  assert.equal(stale.isError, true);
  assert.equal(z.object({ cart: cartSchema }).parse(stale.structuredContent).cart.count, 3);
  const current = await client.callTool({ name: "get_cart", arguments: {} });
  assert.equal(
    z.object({ cart: cartSchema }).parse(current.structuredContent).cart.totalCents,
    1500,
  );
  const noRevision = await client.callTool({
    name: "set_cart_quantity",
    arguments: { product_id: "coffee", quantity: 0 },
  });
  assert.equal(noRevision.isError, true);
  assert.equal(s.runtime.commerce.cart(alice.userId).count, 3);
  const codex = await s.client(renewed.access_token, true);
  assert.deepEqual((await codex.listTools()).tools.map((tool) => tool.name).sort(), [
    "get_cart",
    "list_products",
    "set_cart_quantity",
  ]);
  const codexCart = await codex.callTool({ name: "get_cart", arguments: {} });
  assert.equal(
    z.object({ cart: cartSchema }).parse(codexCart.structuredContent).cart.totalCents,
    1500,
  );
  const codexApp = await codex.readResource({ uri: "ui://fx-web/shop" });
  assert.equal(codexApp.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok("text" in codexApp.contents[0] && codexApp.contents[0].text.length > 1000);
  assert.equal((await s.native("auth/sign-out", {}, alice.cookie, alice.userId)).status, 200);
  const denied = await client.callTool({ name: "get_cart", arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /Sign in/);
  assert.equal((await codex.callTool({ name: "get_cart", arguments: {} })).isError, true);
  assert.ok(await sessionIdentity(s.runtime, new Headers({ cookie: bob.cookie })));
});

test("write-only MCP grants acknowledge cart mutations without requiring catalog access", async (t) => {
  const s = await providerFixture(t);
  const alice = await s.account("mcp_write_only");
  const grant = await s.grant(alice, "shop:write offline_access");
  const client = await s.client(grant.access_token);
  const changed = await client.callTool({
    name: "set_cart_quantity",
    arguments: { product_id: "coffee", quantity: 1, expectedRevision: 0 },
  });
  assert.equal(changed.isError, undefined);
  const payload = z
    .object({ cart: cartSchema, catalog: z.unknown().optional() })
    .parse(changed.structuredContent);
  assert.equal(payload.cart.totalCents, 500);
  assert.equal(payload.catalog, undefined);
  assert.deepEqual(payload.cart, s.runtime.commerce.cart(alice.userId));
  for (const name of ["list_products", "get_cart"]) {
    const denied = await client.callTool({ name, arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /Authorization does not permit/);
  }
});

test("MCP distinguishes cryptographic rejection from session and scope rejection without mutating another user's cart", async (t) => {
  const s = await providerFixture(t);
  const alice = await s.account("mcp_policy");
  const challenge = await s.beginGrant(alice, "shop:read offline_access");
  const wrongVerifier = await challenge.exchange("x".repeat(43));
  assert.equal(wrongVerifier.status, 401, await wrongVerifier.clone().text());
  assert.deepEqual(await wrongVerifier.json(), {
    error_description: "code verification failed",
    error: "invalid_request",
  });
  const grant = await s.grant(alice, "shop:read offline_access");
  for (const field of ["jwks_uri", "backchannel_logout_uri", "sector_identifier_uri"]) {
    const unsupported = { [field]: "https://example.invalid/metadata" };
    const created = await s.native(
      "auth/oauth2/create-client",
      {
        client_name: "Unsupported callbacks",
        application_type: "native",
        redirect_uris: [s.origin + "/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        ...unsupported,
      },
      alice.cookie,
      alice.userId,
    );
    assert.equal(created.status, 400);
    assert.deepEqual(await created.json(), {
      error: "Client metadata is unavailable or not approved.",
    });
    const updated = await s.native(
      "auth/oauth2/update-client",
      {
        client_id: grant.client_id,
        update: unsupported,
      },
      alice.cookie,
      alice.userId,
    );
    assert.equal(updated.status, 400);
    assert.deepEqual(await updated.json(), {
      error: "Client metadata is unavailable or not approved.",
    });
  }
  const continuation = await s.native(
    "auth/oauth2/continue",
    {
      selected: true,
      oauth_query: new URLSearchParams({
        client_id: "https://unapproved.invalid/client.json",
      }).toString(),
    },
    alice.cookie,
    alice.userId,
  );
  assert.equal(continuation.status, 400);
  assert.deepEqual(await continuation.json(), {
    error: "Client metadata is unavailable or not approved.",
  });
  const update = await s.native(
    "auth/oauth2/update-client",
    {
      client_id: grant.client_id,
      update: { client_name: "Renamed reference host" },
    },
    alice.cookie,
    alice.userId,
  );
  assert.equal(update.status, 200, await update.clone().text());
  const readOnly = await s.client(grant.access_token);
  assert.equal((await readOnly.callTool({ name: "get_cart", arguments: {} })).isError, undefined);
  assert.equal(
    (
      await readOnly.callTool({
        name: "set_cart_quantity",
        arguments: { product_id: "coffee", quantity: 1, expectedRevision: 0 },
      })
    ).isError,
    true,
  );
  const signerDb = new DatabaseSync(s.path);
  t.after(() => signerDb.close());
  const signer = betterAuth({
    database: signerDb,
    secret: testSecret,
    baseURL: s.origin,
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    plugins: [jwt()],
  });
  const claims = decode(grant.access_token);
  const signed = async (payload: Record<string, unknown>) =>
    (await signer.api.signJWT({ body: { payload } })).token;
  async function deniedHttp(token?: string, cookie = "", dpop?: string) {
    return fetch(s.runtime.resource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
        cookie,
        ...(token ? { authorization: (dpop ? "DPoP " : "Bearer ") + token } : {}),
        ...(dpop ? { DPoP: dpop } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "auth-boundary", version: "1" },
          },
        },
      }),
    });
  }
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const thumbprint = createHash("sha256")
    .update(
      JSON.stringify({
        crv: publicJwk.crv,
        kty: publicJwk.kty,
        x: publicJwk.x,
        y: publicJwk.y,
      }),
    )
    .digest("base64url");
  const boundToken = await signed({ ...claims, cnf: { jkt: thumbprint } });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const proofData =
    encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }) +
    "." +
    encode({
      htu: s.runtime.resource,
      htm: "POST",
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      ath: createHash("sha256").update(boundToken).digest("base64url"),
    });
  const proof =
    proofData +
    "." +
    sign("sha256", Buffer.from(proofData), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  assert.equal((await deniedHttp(boundToken)).status, 401);
  const firstProof = await deniedHttp(boundToken, "", proof);
  assert.equal(firstProof.status, 200, await firstProof.clone().text());
  assert.equal((await deniedHttp(boundToken, "", proof)).status, 401);
  const cookieOnly = await deniedHttp(undefined, alice.cookie);
  assert.equal(cookieOnly.status, 401);
  assert.match(cookieOnly.headers.get("www-authenticate") ?? "", /resource_metadata/);
  const segments = grant.access_token.split(".");
  segments[2] = (segments[2][0] === "A" ? "B" : "A") + segments[2].slice(1);
  assert.equal((await deniedHttp(segments.join("."))).status, 401);
  for (const override of [
    { aud: s.origin + "/different" },
    { iss: s.origin + "/different-issuer" },
    { exp: Math.floor(Date.now() / 1000) - 60 },
    { sid: undefined },
    { fx_native_user_id: undefined },
  ])
    assert.equal((await deniedHttp(await signed({ ...claims, ...override }))).status, 401);
  const pairwise = await s.client(await signed({ ...claims, sub: "pairwise-external-subject" }));
  assert.equal((await pairwise.callTool({ name: "get_cart", arguments: {} })).isError, undefined);
  for (const override of [{ sid: "not-a-native-session" }, { fx_native_user_id: "another-user" }]) {
    const client = await s.client(await signed({ ...claims, ...override }));
    assert.equal((await client.callTool({ name: "get_cart", arguments: {} })).isError, true);
  }
  signerDb
    .prepare("UPDATE sessions SET expiresAt=? WHERE id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), alice.identity.sessionId);
  assert.equal((await readOnly.callTool({ name: "get_cart", arguments: {} })).isError, true);
  assert.equal(s.runtime.commerce.cart(alice.userId).count, 0);
});

test("client metadata accepts a 200 body up to 64 KiB and cancels a larger one", async () => {
  const limit = 64 * 1024;
  const accepted = await boundedMetadata(new Response(new Uint8Array(limit)));
  assert.equal((await accepted.arrayBuffer()).byteLength, limit);
  await assert.rejects(boundedMetadata(new Response(new Uint8Array(limit + 1))), /too large/);
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.enqueue(new Uint8Array(4096)),
    cancel: () => void (cancelled = true),
  });
  await assert.rejects(boundedMetadata(new Response(endless)), /too large/);
  assert.equal(cancelled, true);
  await assert.rejects(boundedMetadata(new Response(null, { status: 302 })), /HTTP 200/);
  await assert.rejects(boundedMetadata(new Response("{}", { status: 404 })), /HTTP 200/);
});
