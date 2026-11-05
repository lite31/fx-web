import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccount } from "../src/lib/account.ts";
import { createGatewayFetch } from "../src/lib/gateway-fetch.ts";

test("browser transport supports the SDK's model capability lookup without exposing credentials", async (t) => {
  const errors: string[] = [];
  const proxyFetch = createGatewayFetch({
    reportError: (message) => errors.push(message),
    account: createAccount({
      userId: "buyer-a",
      signal: new AbortController().signal,
      onUnauthorized: () => {},
    }),
  });
  const upstream = t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, "/api/models");
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.get("x-fx-user-id"), "buyer-a");
      return Response.json({ data: [{ id: "test-model", type: "language" }] });
    },
  );
  const response = await proxyFetch("https://ai-gateway.vercel.sh/coding-agent/v1/models", {
    headers: { authorization: "Bearer server-proxy" },
  });
  assert.deepEqual(await response.json(), { data: [{ id: "test-model", type: "language" }] });
  assert.equal(upstream.mock.callCount(), 1);
  assert.deepEqual(errors, []);
});

test("browser transport reports reset-required limits without classifying ordinary failures as limits", async (t) => {
  const errors: string[] = [];
  let limits = 0;
  let unauthorized = 0;
  const proxyFetch = createGatewayFetch({
    reportError: (message) => errors.push(message),
    account: createAccount({
      userId: "buyer-a",
      signal: new AbortController().signal,
      onUnauthorized: () => unauthorized++,
    }),
    onConversationLimit: () => limits++,
  });
  for (const [status, body, expectedLimits] of [
    [400, { error: "Start a new conversation.", code: "conversation_limit" }, 1],
    [413, { error: "Start a new conversation.", code: "conversation_limit" }, 2],
    [400, { error: "Invalid conversation." }, 2],
    [413, { error: "Request too large." }, 2],
    [503, { error: "Unavailable." }, 2],
    [401, { error: "Sign in to continue." }, 2],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body, { status }));
    await assert.rejects(
      proxyFetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST" }),
      { message: body.error },
    );
    assert.equal(errors.at(-1), body.error);
    assert.equal(limits, expectedLimits);
  }
  assert.equal(unauthorized, 1);
});

test("browser transport restricts endpoints, strips credentials, and forwards cancellation", async (t) => {
  const errors: string[] = [];
  const proxyFetch = createGatewayFetch({
    reportError: (message) => errors.push(message),
    account: createAccount({
      userId: "buyer-a",
      signal: new AbortController().signal,
      onUnauthorized: () => {},
    }),
  });
  const abort = new AbortController();
  let forwardedSignal: AbortSignal | undefined;
  const upstream = t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init);
      assert.equal(input, "/api/generate");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      assert.equal(new Headers(init.headers).get("x-fx-user-id"), "buyer-a");
      assert.equal(init.body, '{"prompt":[]}');
      forwardedSignal = init.signal ?? undefined;
      return new Response("reply");
    },
  );
  for (const url of [
    "https://ai-gateway.vercel.sh/coding-agent/v1/models",
    "https://other.example/v4/ai/language-model",
    "https://ai-gateway.vercel.sh/unknown",
    "https://ai-gateway.vercel.sh/v4/ai/language-model?override=1",
  ]) {
    await assert.rejects(
      proxyFetch(url, { method: "POST", body: '{"prompt":[]}' }),
      /unsupported model endpoint/,
    );
  }
  await assert.rejects(
    proxyFetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "GET" }),
    /unsupported model endpoint/,
  );
  assert.equal(upstream.mock.callCount(), 0);
  const response = await proxyFetch("https://ai-gateway.vercel.sh/v4/ai/language-model", {
    method: "POST",
    headers: { authorization: "Bearer placeholder" },
    body: '{"prompt":[]}',
    signal: abort.signal,
  });
  assert.equal(await response.text(), "reply");
  abort.abort();
  assert.equal(forwardedSignal?.aborted, true);
  assert.equal(errors.length, 5);
});

test("browser transport forwards bytes immediately, observes split SSE errors, and cancels the source", async (t) => {
  const errors: string[] = [];
  const proxyFetch = createGatewayFetch({
    reportError: (message) => errors.push(message),
    account: createAccount({
      userId: "buyer-a",
      signal: new AbortController().signal,
      onUnauthorized: () => {},
    }),
  });
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const encoder = new TextEncoder();
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const response = await proxyFetch("https://ai-gateway.vercel.sh/v4/ai/language-model", {
    method: "POST",
  });
  assert.ok(response.body);
  assert.ok(source);
  const reader = response.body.getReader();
  source.enqueue(encoder.encode('data: {"type":"err'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"err');
  assert.deepEqual(errors, []);
  source.enqueue(encoder.encode('or","error":"Try again."}\n\n'));
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    'or","error":"Try again."}\n\n',
  );
  assert.deepEqual(errors, ["Try again."]);
  await reader.cancel();
  // pipeThrough propagates cancellation asynchronously to the source.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);

  for (const payload of [null, { error: 42 }, { message: "Unrecognized response" }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload, { status: 503 }));
    await assert.rejects(
      proxyFetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST" }),
      /Unable to reach the model\. Try again\./,
    );
    assert.equal(errors.at(-1), "Unable to reach the model. Try again.");
  }
});
