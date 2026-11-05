import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { getRequest, setResponse } from "@sveltejs/kit/node";
import { api } from "../src/lib/server/api.ts";
import { fixture } from "./fixture.ts";
const setup = await fixture();

const environment = {
  runtime: setup.runtime,
  gatewayKey: "test-server-secret",
  model: "spacexai/grok-4.1-fast-non-reasoning",
};
const prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];

test("model metadata requires the current account and uses only server credentials at a fixed upstream", async (t) => {
  const catalog = { data: [{ id: environment.model, type: "language", context_window: 100_000 }] };
  const upstream = t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(url, "https://ai-gateway.vercel.sh/coding-agent/v1/models");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-server-secret");
      assert.equal(headers.has("cookie"), false);
      return Response.json(catalog, { headers: { "set-cookie": "private=upstream" } });
    },
  );
  for (const [cookie, userId, status] of [
    ["", setup.session.userId, 401],
    [setup.cookie, "another-account", 401],
    [setup.cookie, setup.session.userId, 200],
  ] as const) {
    const response = await setup.request("models", undefined, cookie, userId);
    assert.equal(response.status, status);
    if (response.ok) {
      assert.deepEqual(await response.json(), catalog);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal(response.headers.has("authorization"), false);
    }
  }
  assert.equal(upstream.mock.callCount(), 1);

  const missingKey = await api.request(
    "http://localhost/api/models",
    {
      headers: { cookie: setup.cookie, "x-fx-user-id": setup.session.userId },
    },
    { ...environment, gatewayKey: undefined },
  );
  assert.equal(missingKey.status, 503);
  assert.equal(upstream.mock.callCount(), 1);

  for (const networkFailure of [false, true]) {
    t.mock.method(globalThis, "fetch", async () => {
      if (networkFailure) throw new Error("Private test-server-secret");
      return Response.json(
        { error: { type: "unauthorized", message: "Private test-server-secret" } },
        { status: 401 },
      );
    });
    const response = await setup.request("models");
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /test-server-secret|Private/);
  }
});

test("proxy distinguishes exhausted conversations from invalid protocol and keeps both request caps", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("accepted"));
  const limit = {
    error: "This conversation reached its limit. Start a new conversation to continue.",
    code: "conversation_limit",
  };
  const boundary = { prompt, padding: "" };
  const padding = "x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(boundary)));
  for (const [body, status, expected] of [
    [{ prompt: Array.from({ length: 40 }, () => prompt[0]) }, 200, undefined],
    [{ prompt: Array.from({ length: 41 }, () => prompt[0]) }, 400, limit],
    [{ ...boundary, padding }, 200, undefined],
    [{ ...boundary, padding: padding + "x" }, 413, limit],
    [
      { prompt: Array.from({ length: 41 }, () => ({ role: "invalid" })) },
      400,
      { error: "Send a supported conversation of 1–40 messages." },
    ],
    [
      { prompt: [{ role: "user", content: [{ type: "image" }] }] },
      400,
      { error: "Send a supported conversation of 1–40 messages." },
    ],
  ] as const) {
    const response = await setup.request("generate", body);
    assert.equal(response.status, status);
    if (expected) assert.deepEqual(await response.json(), expected);
    else assert.equal(await response.text(), "accepted");
  }
  const oversizedCart = await setup.request("cart/quantity", { padding: "x".repeat(65_536) });
  assert.equal(oversizedCart.status, 413);
  assert.deepEqual(await oversizedCart.json(), { error: "Request too large." });
  assert.equal(upstream.mock.callCount(), 2);
});

test("oversized generation delivers its reset-required response over real HTTP", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () =>
    assert.fail("Oversized body reached Gateway"),
  );
  const authorized = t.mock.method(setup.runtime, "authorized", () =>
    assert.fail("Oversized body reached auth"),
  );
  const closedConnections: Promise<void>[] = [];
  const server = createServer(async (req, res) => {
    closedConnections.push(new Promise((resolve) => req.socket.once("close", resolve)));
    const request = await getRequest({ request: req, base: "http://localhost" });
    await setResponse(res, await api.fetch(request, environment));
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const finished of [true, false]) {
    await t.test(
      finished ? "completed upload" : "unfinished chunked upload",
      { timeout: 5000 },
      async () => {
        const response = await new Promise<{ status: number | undefined; body: string }>(
          (resolve, reject) => {
            const client = httpRequest(
              {
                hostname: "127.0.0.1",
                port: address.port,
                path: "/api/generate",
                method: "POST",
                headers: { origin: "http://localhost", "content-type": "application/json" },
              },
              (response) => {
                assert.equal(response.headers.connection, "close");
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                  body += chunk;
                });
                response.on("end", () => resolve({ status: response.statusCode, body }));
                response.on("error", reject);
              },
            );
            client.on("error", reject);
            client.setTimeout(3000, () =>
              client.destroy(new Error("413 waited for the upload to finish")),
            );
            const body = JSON.stringify({
              prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(65_536) }] }],
            });
            if (finished) client.end(body);
            else client.write(body);
          },
        );
        assert.equal(response.status, 413);
        assert.deepEqual(JSON.parse(response.body), {
          error: "This conversation reached its limit. Start a new conversation to continue.",
          code: "conversation_limit",
        });
        await closedConnections.at(-1);
      },
    );
  }
  assert.equal(authorized.mock.callCount(), 0);
  assert.equal(upstream.mock.callCount(), 0);
});

test("proxy rejects remote origins, unsupported conversations and tools, and missing credentials before calling Gateway", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected upstream call");
  });
  for (const [origin, body, expected, expectedError] of [
    ["https://other.example", { prompt }, 403],
    [undefined, { prompt }, 403],
    ["http://localhost", { tools: 17 }, 400, "Use only the supported shopping tools."],
    ["http://localhost", { prompt: [] }, 400],
    [
      "http://localhost",
      { prompt: [{ role: "user", content: [{ type: "reasoning", text: "hidden" }] }] },
      400,
    ],
    [
      "http://localhost",
      { prompt: [{ role: "system", content: [{ type: "reasoning", text: "hidden" }] }] },
      400,
    ],
    [
      "http://localhost",
      { prompt: [{ role: "assistant", content: [{ type: "reasoning", text: 42 }] }] },
      400,
    ],
    [
      "http://localhost",
      { prompt: [{ role: "assistant", content: [{ type: "tool-call", text: "unsupported" }] }] },
      400,
    ],
    ["http://localhost", { prompt, tools: [{ type: "function", name: "run_shell" }] }, 400],
    ["http://localhost", { prompt, tools: [{ type: "provider", name: "get_cart" }] }, 400],
    [
      "http://localhost",
      {
        prompt,
        tools: [
          { type: "function", name: "get_cart" },
          { type: "function", name: "get_cart" },
        ],
      },
      400,
    ],
    [
      "http://localhost",
      { prompt: [{ role: ["assistant"], content: [{ type: "text", text: "bad role" }] }] },
      400,
    ],
    ...[
      { type: "tool-call", toolCallId: "call", toolName: "run_shell", input: {} },
      { type: "tool-call", toolCallId: "call", toolName: "get_cart", input: [] },
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "get_cart",
        output: { type: ["text"], value: "bad output" },
      },
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "get_cart",
        output: { type: "json", value: {} },
      },
    ].map(
      (part) =>
        [
          "http://localhost",
          { prompt: [{ role: part.type === "tool-call" ? "assistant" : "tool", content: [part] }] },
          400,
        ] as const,
    ),
    [
      "http://localhost",
      { prompt: [{ role: "tool", content: [{ type: "text", text: "unsupported" }] }] },
      400,
    ],
  ] as const) {
    const headers = new Headers({
      "content-type": "application/json",
      "x-fx-user-id": setup.session.userId,
      cookie: setup.cookie,
    });
    if (origin) headers.set("origin", origin);
    const response = await api.request(
      "http://localhost/api/generate",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      environment,
    );
    assert.equal(response.status, expected);
    if (expectedError) assert.deepEqual(await response.json(), { error: expectedError });
  }
  const remote = await api.request("https://public.example/api/config", {}, environment);
  assert.equal(remote.status, 403);
  const missingKey = await api.request(
    "http://localhost/api/generate",
    {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "x-fx-user-id": setup.session.userId,
        cookie: setup.cookie,
      },
      body: JSON.stringify({ prompt }),
    },
    { model: environment.model, runtime: setup.runtime },
  );
  assert.equal(missingKey.status, 503);
  assert.equal(upstream.mock.callCount(), 0);
});

test("proxy preserves assistant reasoning history, keeps credentials private, and streams without buffering", async (t) => {
  const conversation = [
    { role: "system", content: "Help with the shop.", providerOptions: { fixture: true } },
    { role: "system", content: [{ type: "text", text: "Use the available tools." }] },
    ...prompt,
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Thinking through the greeting." },
        {
          type: "reasoning",
          text: "",
          providerOptions: { openai: { reasoningEncryptedContent: "opaque" } },
        },
        { type: "text", text: "Hello!" },
        {
          type: "tool-call",
          toolName: "get_cart",
          toolCallId: "cart-call",
          input: {},
          providerOptions: { fixture: { opaque: "call-metadata" } },
        },
      ],
    },
    {
      role: "tool",
      providerOptions: { fixture: { opaque: "message-metadata" } },
      content: [
        {
          type: "tool-result",
          toolName: "get_cart",
          toolCallId: "cart-call",
          output: { type: "text", value: "{}", providerOptions: { fixture: true } },
        },
        {
          type: "tool-result",
          toolName: "get_cart",
          toolCallId: "failed-call",
          output: { type: "error-text", value: "Unavailable." },
        },
        {
          type: "tool-result",
          toolName: "set_cart_quantity",
          toolCallId: "denied-call",
          output: { type: "execution-denied", reason: "Not approved." },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Tell me more." }] },
  ];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
  });
  const upstream = t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  );
  const config = await api.request("http://localhost/api/config", {}, environment);
  assert.deepEqual(await config.json(), { model: environment.model, configured: true });
  const response = await api.request(
    "http://localhost/api/generate",
    {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "x-fx-user-id": setup.session.userId,
        cookie: setup.cookie,
        authorization: "Bearer browser-placeholder",
      },
      body: JSON.stringify({ prompt: conversation, maxOutputTokens: 100_000 }),
    },
    environment,
  );
  assert.equal(response.status, 200);
  const [url, options] = upstream.mock.calls[0].arguments;
  assert.ok(options);
  assert.ok(options.signal);
  assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/language-model");
  assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-server-secret");
  assert.equal(new Headers(options.headers).get("ai-language-model-id"), environment.model);
  assert.deepEqual(JSON.parse(String(options.body)), {
    prompt: conversation,
    maxOutputTokens: 1024,
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.has("authorization"), false);
  assert.ok(response.body);
  assert.ok(controller);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
  controller.enqueue(new TextEncoder().encode("data: second\n\n"));
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: second\n\n");
  controller.close();
  assert.equal((await reader.read()).done, true);
});

test("proxy reports useful streamed errors without exposing Gateway response details", async (t) => {
  for (const [status, type, expected] of [
    [
      403,
      "customer_verification_required",
      "AI Gateway requires a card on file. Complete verification in the Vercel dashboard.",
    ],
    [429, "rate_limit", "Gateway rate limit reached. Try again shortly."],
    [401, "unauthorized", "Gateway could not respond. Check the server key and selected model."],
    [0, "network", "Unable to reach AI Gateway. Try again shortly."],
    [-1, "broken_stream", "Unable to reach AI Gateway. Try again shortly."],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => {
      if (!status) throw new Error("Private network details test-server-secret");
      if (status < 0)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta"'));
            },
            pull(controller) {
              controller.error(new Error("Private stream details test-server-secret"));
            },
          }),
        );
      return Response.json(
        { error: { type, message: "Private upstream details test-server-secret" } },
        { status },
      );
    });
    const response = await api.request(
      "http://localhost/api/generate",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "x-fx-user-id": setup.session.userId,
          cookie: setup.cookie,
        },
        body: JSON.stringify({ prompt }),
      },
      environment,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.equal(text.includes("test-server-secret"), false);
    const event = text.trim().split("\n\n").at(-1);
    assert.ok(event);
    assert.deepEqual(JSON.parse(event.replace(/^data: /, "")), {
      type: "error",
      error: expected,
    });
  }
});

test("disconnecting after a complete POST cancels Gateway before headers and during streaming", async (t) => {
  for (const streaming of [false, true]) {
    await t.test(
      streaming ? "during streaming" : "before upstream headers",
      { timeout: 5_000 },
      async (t) => {
        const started = Promise.withResolvers<void>();
        const cancelled = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<Response>();
        void pending.promise.catch(() => {});
        let requestSignal: AbortSignal | undefined;
        t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
          const signal = init?.signal;
          assert.ok(signal);
          signal.addEventListener(
            "abort",
            () => {
              cancelled.resolve();
              if (!streaming) pending.reject(signal.reason);
            },
            { once: true },
          );
          started.resolve();
          if (!streaming) return pending.promise;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              },
              cancel() {
                cancelled.resolve();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        });
        const server = createServer(async (req, res) => {
          const request = await getRequest({ request: req, base: "http://localhost" });
          requestSignal = request.signal;
          await setResponse(res, await api.fetch(request, environment));
        });
        t.after(() => {
          if (!streaming) pending.reject(new Error("Test finished"));
          server.closeAllConnections();
          server.close();
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const chunk = Promise.withResolvers<void>();
        const client = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/api/generate",
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost",
              "x-fx-user-id": setup.session.userId,
              cookie: setup.cookie,
            },
          },
          (response) => response.once("data", () => chunk.resolve()),
        );
        client.on("error", () => {});
        client.end(JSON.stringify({ prompt }));
        await started.promise;
        if (streaming) await chunk.promise;
        client.destroy();
        await cancelled.promise;
        assert.equal(requestSignal?.aborted, false, "The request body completed normally");
      },
    );
  }
});
