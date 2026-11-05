import assert from "node:assert/strict";
import { z } from "zod";
import { createRuntime, type Runtime } from "../src/lib/server/application-runtime.ts";
import { api } from "../src/lib/server/api.ts";
import { authUserSchema } from "../src/lib/contract.ts";

const sessionResponseSchema = z
  .object({ session: z.object({ id: z.string() }), user: z.object({ id: z.string() }) })
  .nullable();

// Reads the cookie's session through Better Auth's route, as the browser does.
export async function sessionIdentity(runtime: Runtime, headers: Headers) {
  const response = await runtime.handle(
    new Request("http://localhost/api/auth/get-session", { headers }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = sessionResponseSchema.parse(await response.json());
  return body && { userId: body.user.id, sessionId: body.session.id };
}

export const testSecret = "fixture-auth-secret-at-least-32-characters";
let fixtureNumber = 0;
export const fixtureProducts = [
  {
    id: "coffee",
    name: "Fixture coffee",
    emoji: "☕",
    currency: "EUR",
    priceCents: 500,
    stock: 10,
  },
  { id: "plant", name: "Fixture plant", emoji: "🌱", currency: "EUR", priceCents: 1800, stock: 10 },
];
export async function fixture(path = ":memory:") {
  // Give fixtures separate client addresses so Better Auth's rate limits do not leak between tests.
  const clientAddress = `192.0.2.${++fixtureNumber}`;
  const runtime = await createRuntime({ path, secret: testSecret, baseURL: "http://localhost" });
  const commerce = runtime.commerce;
  commerce.importCatalog(fixtureProducts);
  const environment = { runtime, gatewayKey: "test-server-secret", model: "test-model" };
  const identities = new Map<string, string>();
  const request = async (
    path: string,
    input?: unknown,
    useCookie = cookie,
    expectedUserId = identities.get(useCookie) ?? "",
  ) => {
    const response = await api.request(
      `http://localhost/api/${path}`,
      {
        method: input === undefined ? "GET" : "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "x-real-ip": clientAddress,
          cookie: useCookie,
          ...(expectedUserId ? { "x-fx-user-id": expectedUserId } : {}),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      },
      environment,
    );
    if (response.ok && /^auth\/sign-(in|up)\//.test(path)) {
      const user = authUserSchema.parse(await response.clone().json()).user;
      const signedCookie = response.headers
        .getSetCookie()
        .map((header) => header.split(";")[0])
        .join("; ");
      identities.set(signedCookie, user.id);
    }
    return response;
  };
  async function authenticate(username: string, password: string, register = true) {
    const response = await request(
      register ? "auth/sign-up/email" : "auth/sign-in/username",
      {
        username,
        password,
        ...(register ? { email: `${username}@example.com`, name: username } : {}),
      },
      "",
    );
    assert.equal(response.status, 200, await response.clone().text());
    const authenticatedCookie = response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .join("; ");
    const identity = await sessionIdentity(runtime, new Headers({ cookie: authenticatedCookie }));
    assert.ok(identity);
    return { cookie: authenticatedCookie, session: identity };
  }
  // Answers a browser-side Account fetch of `/api/...` as the cookie account the test chooses.
  const browserFetch = (url: string, init: RequestInit = {}, useCookie = cookie) =>
    request(
      url.slice("/api/".length),
      typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      useCookie,
      new Headers(init.headers).get("x-fx-user-id") ?? "",
    );
  let cookie = "";
  const signedIn = await authenticate("fixture", "fixture-password");
  cookie = signedIn.cookie;
  // Starts a signed-in POST whose body arrives only on release(), so a test can end the session mid-upload.
  function delayedPost(path: string, input: unknown) {
    const payload = new TextEncoder().encode(JSON.stringify(input));
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "content-length": String(payload.byteLength),
        "x-fx-user-id": signedIn.session.userId,
        cookie,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
      duplex: "half",
    };
    return {
      response: api.fetch(new Request(`http://localhost/api/${path}`, init), environment),
      release() {
        body?.enqueue(payload);
        body?.close();
      },
    };
  }
  return {
    runtime,
    commerce,
    environment,
    cookie,
    session: signedIn.session,
    request,
    browserFetch,
    authenticate,
    delayedPost,
  };
}
