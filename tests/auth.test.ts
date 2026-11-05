import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "../src/lib/server/application-runtime.ts";
import { authErrorSchema, authUserSchema, sessionSchema } from "../src/lib/contract.ts";
import { api } from "../src/lib/server/api.ts";
import { fixture, sessionIdentity, testSecret } from "./fixture.ts";

const cookieFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");

test("core signs up real email accounts, normalizes usernames, validates credentials and cookie signatures, and revokes sessions", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const created = await s.request(
    "auth/sign-up/email",
    {
      username: " Mixed_User ",
      name: "Mixed user",
      email: "mixed@example.com",
      password: "mixed-user-password",
    },
    "",
  );
  assert.equal(created.status, 200, await created.clone().text());
  const account = authUserSchema.parse(await created.json());
  assert.equal(account.user.username, "mixed_user");
  const signedCookie = cookieFrom(created);
  assert.match(signedCookie, /better-auth\.session_token=/);
  const signedHeaders = new Headers({ cookie: signedCookie });
  const identity = await sessionIdentity(s.runtime, signedHeaders);
  assert.equal(identity?.userId, account.user.id);
  const duplicate = await s.request(
    "auth/sign-up/email",
    {
      username: "mixed_user",
      name: "Duplicate",
      email: "duplicate@example.com",
      password: "mixed-user-password",
    },
    "",
  );
  assert.equal(duplicate.status, 400);
  const invalid = await s.request(
    "auth/sign-in/username",
    { username: "mixed_user", password: "wrong-password" },
    "",
  );
  assert.equal(invalid.status, 401);
  assert.ok(authErrorSchema.safeParse(await invalid.json()).success);
  assert.equal(invalid.headers.has("set-cookie"), false);
  const login = await s.request(
    "auth/sign-in/username",
    { username: "mixed_user", password: "mixed-user-password" },
    "",
  );
  assert.equal(login.status, 200);
  const equals = signedCookie.indexOf("=");
  const value = decodeURIComponent(signedCookie.slice(equals + 1));
  const signatureStart = value.lastIndexOf(".") + 1;
  assert.ok(signatureStart > 0);
  assert.match(value.slice(signatureStart), /^[A-Za-z0-9+/]{43}=$/);
  const tampered =
    signedCookie.slice(0, equals + 1) +
    encodeURIComponent(
      value.slice(0, signatureStart) +
        (value[signatureStart] === "A" ? "B" : "A") +
        value.slice(signatureStart + 1),
    );
  assert.equal(await sessionIdentity(s.runtime, new Headers({ cookie: tampered })), null);
  assert.equal((await sessionIdentity(s.runtime, signedHeaders))?.userId, account.user.id);
  assert.equal((await s.request("auth/sign-out", {}, signedCookie)).status, 200);
  assert.equal(await sessionIdentity(s.runtime, signedHeaders), null);
  assert.deepEqual(
    await (await s.request("auth/get-session", undefined, signedCookie)).json(),
    null,
  );
  assert.equal((await s.request("cart", undefined, signedCookie)).status, 401);
  assert.equal((await s.request("cart", undefined, cookieFrom(login))).status, 200);
});

test("native email-only accounts project their name and own the same lazy cart", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const created = await s.request(
    "auth/sign-up/email",
    { name: "Email customer", email: "email@example.com", password: "email-customer-password" },
    "",
  );
  assert.equal(created.status, 200);
  const user = authUserSchema.parse(await created.json()).user;
  assert.equal(user.username, "Email customer");
  const cookie = cookieFrom(created);
  const session = sessionSchema.parse(
    await (await s.request("auth/get-session", undefined, cookie)).json(),
  );
  assert.deepEqual(session.user, user);
  const mutation = await s.request(
    "cart/quantity",
    { product_id: "coffee", quantity: 2, expectedRevision: 0 },
    cookie,
  );
  assert.equal(mutation.status, 200);
  assert.equal((await mutation.json()).totalCents, 1000);
  assert.equal((await (await s.request("cart")).json()).count, 0);
  assert.equal((await s.request("auth/sign-out", {}, cookie)).status, 200);
  const login = await s.request(
    "auth/sign-in/email",
    { email: "email@example.com", password: "email-customer-password" },
    "",
  );
  assert.equal(login.status, 200);
  assert.equal(
    (await (await s.request("cart", undefined, cookieFrom(login))).json()).totalCents,
    1000,
  );
});

test("native auth validates email, username and password bounds and owns local request throttling", async (t) => {
  for (const fields of [
    { email: "not-an-email" },
    { username: "bad user" },
    { username: "x" },
    { username: "x".repeat(65) },
    { password: "short" },
    { password: "x".repeat(129) },
  ]) {
    const s = await fixture();
    try {
      const response = await s.request(
        "auth/sign-up/email",
        {
          name: "Invalid",
          username: "invalid",
          email: "invalid@example.com",
          password: "valid-password",
          ...fields,
        },
        "",
      );
      assert.equal(response.ok, false);
      assert.equal(response.status, 400);
      assert.equal(response.headers.has("set-cookie"), false);
    } finally {
      await s.runtime.close();
    }
  }
  const s = await fixture();
  t.after(() => s.runtime.close());
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal(
      (
        await s.request(
          "auth/sign-in/username",
          { username: "fixture", password: "incorrect-password" },
          "",
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await s.request(
        "auth/sign-in/username",
        { username: "fixture", password: "fixture-password" },
        "",
      )
    ).status,
    429,
  );
  assert.equal((await s.request("cart")).status, 200);
});

test("auth transactions and concurrent cart operations share one queue without blocking other accounts", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const [first, cart, second] = await Promise.all([
    s.authenticate("concurrent_a", "concurrent-password"),
    s.request("cart/quantity", { product_id: "coffee", quantity: 2, expectedRevision: 0 }),
    s.authenticate("concurrent_b", "concurrent-password"),
  ]);
  assert.equal(cart.status, 200);
  assert.equal((await cart.json()).totalCents, 1000);
  assert.equal((await (await s.request("cart", undefined, first.cookie)).json()).count, 0);
  assert.equal((await (await s.request("cart", undefined, second.cookie)).json()).count, 0);
  assert.equal((await s.request("auth/sign-out", {})).status, 200);
  assert.equal((await s.request("cart")).status, 401);
  assert.equal((await s.request("cart", undefined, first.cookie)).status, 200);
});

test("both loopback hostnames work at the configured port and unrelated origins remain denied", async (t) => {
  const runtime = await createRuntime({
    path: ":memory:",
    secret: testSecret,
    baseURL: "http://localhost:5173",
  });
  t.after(() => runtime.close());
  const environment = { runtime, model: "test-model" };
  for (const [index, hostname] of ["localhost", "127.0.0.1"].entries()) {
    const origin = `http://${hostname}:5173`;
    const response = await api.request(
      `${origin}/api/auth/sign-up/email`,
      {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-real-ip": `192.0.2.${100 + index}`,
        },
        body: JSON.stringify({
          username: `loopback${index}`,
          name: "Loopback",
          email: `loopback${index}@example.com`,
          password: "loopback-password",
        }),
      },
      environment,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      (
        await api.request(
          `${origin}/api/cart`,
          {
            headers: {
              cookie: cookieFrom(response),
              "x-fx-user-id": authUserSchema.parse(await response.clone().json()).user.id,
            },
          },
          environment,
        )
      ).status,
      200,
    );
  }
  const response = await api.request(
    "http://localhost:5173/api/auth/sign-up/email",
    {
      method: "POST",
      headers: { origin: "https://untrusted.example", "content-type": "application/json" },
      body: "{}",
    },
    environment,
  );
  assert.equal(response.status, 403);
});

test("auth bodies cannot bypass the byte limit with a false Content-Length", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const response = await api.request(
    "http://localhost/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "content-length": "2",
      },
      body: JSON.stringify({ padding: "x".repeat(65_536) }),
    },
    s.environment,
  );
  assert.equal(response.status, 413);
  assert.equal((await s.request("cart")).status, 200);
});
