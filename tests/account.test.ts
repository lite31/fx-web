import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createAccount } from "../src/lib/account.ts";
import { ApiError } from "../src/lib/contract.ts";

const okSchema = z.object({ ok: z.boolean() });
const emptyCart = {
  revision: 3,
  currency: "EUR",
  items: [],
  count: 0,
  subtotalCents: 0,
  totalCents: 0,
};

function account(signal = new AbortController().signal, userId: string | null = "buyer-a") {
  const unauthorized: string[] = [];
  return {
    unauthorized,
    account: createAccount({
      userId: userId ?? undefined,
      signal,
      onUnauthorized: (path) => unauthorized.push(path),
    }),
  };
}

// A real Response whose body ends `lifetime` at the moment it is read.
function abortingResponse(lifetime: AbortController, body: unknown, status: number) {
  const stream = new ReadableStream({
    pull(controller) {
      lifetime.abort();
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

test("account requests carry the expected user and a JSON body", async (t) => {
  const sent = t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, "/api/cart/quantity");
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.body, '{"product_id":"coffee","quantity":2}');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-fx-user-id"), "buyer-a");
      assert.equal(headers.get("content-type"), "application/json");
      return Response.json({ ok: true });
    },
  );
  const { account: buyer } = account();
  assert.deepEqual(
    await buyer.json("cart/quantity", okSchema, { json: { product_id: "coffee", quantity: 2 } }),
    { ok: true },
  );
  assert.equal(sent.mock.callCount(), 1);

  sent.mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(input, "/api/cart");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).has("x-fx-user-id"), false);
    return Response.json({ ok: true });
  });
  await account(new AbortController().signal, null).account.json("cart", okSchema);
  assert.equal(sent.mock.callCount(), 2);
});

test("a 401 reports the path once and throws ApiError", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Sign in to continue." }, { status: 401 }),
  );
  const { account: buyer, unauthorized } = account();
  await assert.rejects(buyer.json("cart", okSchema), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.message, "Sign in to continue.");
    return true;
  });
  assert.deepEqual(unauthorized, ["cart"]);
});

test("error bodies surface cart and code, and unparseable bodies use the failure message", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "Cart changed.", cart: emptyCart, code: "conversation_limit" },
      { status: 409 },
    ),
  );
  const { account: buyer, unauthorized } = account();
  await assert.rejects(buyer.json("cart/quantity", okSchema, { json: {} }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "Cart changed.");
    assert.deepEqual(error.detail, { cart: emptyCart, code: "conversation_limit" });
    return true;
  });

  fetch.mock.mockImplementation(async () => new Response("<html>oops</html>", { status: 500 }));
  await assert.rejects(
    buyer.json("chat", okSchema, { failure: "Unable to load chat." }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Unable to load chat.");
      return true;
    },
  );
  assert.deepEqual(unauthorized, []);
});

test("an account that ends while a body is read rejects with AbortError", async (t) => {
  const lifetime = new AbortController();
  const { account: buyer, unauthorized } = account(lifetime.signal);
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    abortingResponse(lifetime, { ok: true }, 200),
  );
  await assert.rejects(buyer.json("cart", okSchema), { name: "AbortError" });

  const next = new AbortController();
  const { account: later, unauthorized: laterUnauthorized } = account(next.signal);
  fetch.mock.mockImplementation(async () =>
    abortingResponse(next, { error: "Sign in to continue." }, 401),
  );
  await assert.rejects(later.json("cart", okSchema), { name: "AbortError" });
  assert.deepEqual(unauthorized, []);
  assert.deepEqual(laterUnauthorized, []);
});

test("a 401 still reaches the account owner when only the caller cancels", async (t) => {
  const { account: buyer, unauthorized } = account();
  const stop = new AbortController();
  t.mock.method(globalThis, "fetch", async () =>
    abortingResponse(stop, { error: "Sign in to continue." }, 401),
  );
  await assert.rejects(buyer.json("generate", okSchema, { signal: stop.signal }), {
    name: "AbortError",
  });
  assert.deepEqual(unauthorized, ["generate"]);
});

test("within() ends with either lifetime and keeps the 401 policy", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Sign in to continue." }, { status: 401 }),
  );
  const parent = new AbortController();
  const child = new AbortController();
  const { account: buyer, unauthorized } = account(parent.signal);
  const scoped = buyer.within(child.signal);
  assert.equal(scoped.userId, "buyer-a");
  await assert.rejects(scoped.json("chat", okSchema), { status: 401 });
  assert.deepEqual(unauthorized, ["chat"]);

  child.abort();
  assert.equal(scoped.signal.aborted, true);
  assert.equal(buyer.signal.aborted, false);
  await assert.rejects(scoped.fetch("chat"), { name: "AbortError" });

  const other = buyer.within(new AbortController().signal);
  parent.abort();
  assert.equal(other.signal.aborted, true);
  await assert.rejects(other.fetch("chat"), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("keepalive requests outlive the account and never report a 401", async (t) => {
  const lifetime = new AbortController();
  const { account: buyer, unauthorized } = account(lifetime.signal);
  lifetime.abort();
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, "/api/mcp/conversations/c1");
      assert.equal(init?.method, "DELETE");
      assert.equal(init?.keepalive, true);
      assert.equal(init?.signal?.aborted ?? false, false);
      return Response.json({ error: "Sign in to continue." }, { status: 401 });
    },
  );
  await assert.rejects(buyer.fetch("mcp/conversations/c1", { method: "DELETE", keepalive: true }), {
    status: 401,
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(unauthorized, []);
});
