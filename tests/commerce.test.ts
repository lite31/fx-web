import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, fixtureProducts, sessionIdentity, testSecret } from "./fixture.ts";
import { createRuntime } from "../src/lib/server/application-runtime.ts";
import { openDatabase } from "../src/lib/server/commerce.ts";
import { api } from "../src/lib/server/api.ts";

test("authenticated boundaries reject unowned state, money tampering, invalid inputs and revoked sessions", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const upstream = t.mock.method(globalThis, "fetch", () => {
    throw Error("Unexpected Gateway request");
  });
  for (const path of ["catalog", "cart"])
    assert.equal((await s.request(path, undefined, "")).status, 401);
  assert.equal(
    (
      await s.request(
        "generate",
        { prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
        "",
      )
    ).status,
    401,
  );
  for (const extra of [
    { priceCents: 1 },
    { totalCents: 0 },
    { stock: 99 },
    { userId: s.session.userId },
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: 100 },
  ]) {
    assert.equal(
      (
        await s.request("cart/quantity", {
          product_id: "coffee",
          quantity: 1,
          expectedRevision: 0,
          ...extra,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await s.request("cart/quantity", { product_id: "coffee", quantity: 11, expectedRevision: 0 }))
      .status,
    409,
  );
  assert.equal(
    (await s.request("cart/quantity", { product_id: "coffee", quantity: 2, expectedRevision: 0 }))
      .status,
    200,
  );
  const conflict = await s.request("cart/quantity", {
    product_id: "coffee",
    quantity: 3,
    expectedRevision: 0,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).cart.totalCents, 1000);
  const other = await s.authenticate("other", "other-password");
  const cookie = other.cookie;
  assert.equal((await (await s.request("cart", undefined, cookie)).json()).count, 0);
  const quote = await (await s.request("checkout/quote", {})).json();
  assert.equal((await s.request("checkout/confirm", { quoteId: quote.id }, cookie)).status, 404);
  assert.equal(
    (await s.request("checkout/confirm", { quoteId: quote.id, confirmed: true })).status,
    400,
  );
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal(
      (
        await api.request(
          "http://localhost/api/cart/quantity",
          {
            method,
            headers: {
              origin: "https://other.example",
              "x-fx-user-id": s.session.userId,
              cookie: s.cookie,
              "content-type": "application/json",
            },
            body: "{}",
          },
          s.environment,
        )
      ).status,
      403,
    );
  }
  const registration = await s.request("auth/sign-up/email", {
    username: "new_user",
    name: "new_user",
    email: "new_user@example.com",
    password: "long-enough-password",
  });
  const header = registration.headers.get("set-cookie");
  assert.ok(header);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/i);
  assert.equal(header.includes("long-enough-password"), false);
  assert.equal((await s.request("auth/sign-out", {})).status, 200);
  assert.equal((await s.request("cart")).status, 401);
  assert.equal(upstream.mock.callCount(), 0);
});

test("checkout reviews immutable totals, rejects changed conditions and atomically records one idempotent order", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const set = (quantity: number, revision: number) =>
    s.request("cart/quantity", { product_id: "coffee", quantity, expectedRevision: revision });
  await set(2, 0);
  const original = await (await s.request("cart")).json();
  const review = async () => await (await s.request("checkout/quote", {})).json();
  const confirm = (id: string) => s.request("checkout/confirm", { quoteId: id });
  let quote = await review();
  assert.equal(quote.totalCents, 1000);
  assert.deepEqual(await (await s.request("cart")).json(), original);
  assert.equal(s.commerce.catalog().products[0].stock, 10);
  s.commerce.importCatalog([{ ...fixtureProducts[0], priceCents: 600 }]);
  assert.equal((await confirm(quote.id)).status, 409);
  assert.equal(s.commerce.catalog().products[0].stock, 10);
  quote = await review();
  s.commerce.importCatalog([{ ...fixtureProducts[0], priceCents: 600, stock: 1 }]);
  assert.equal((await confirm(quote.id)).status, 409);
  s.commerce.importCatalog([{ ...fixtureProducts[0], stock: 10 }]);
  quote = await review();
  await set(1, 1);
  assert.equal((await confirm(quote.id)).status, 409);
  quote = await review();
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now + 6 * 60_000);
  assert.equal((await confirm(quote.id)).status, 409);
  clock.mock.restore();
  quote = await review();
  const newSession = await s.authenticate("fixture", "fixture-password", false);
  assert.equal(
    (await s.request("checkout/confirm", { quoteId: quote.id }, newSession.cookie)).status,
    409,
  );
  quote = await review();
  const [first, second] = await Promise.all([confirm(quote.id), confirm(quote.id)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const order = await first.json();
  assert.equal((await second.json()).id, order.id);
  assert.equal(order.totalCents, 500);
  assert.equal(s.commerce.catalog().products[0].stock, 9);
  assert.equal((await (await s.request("cart")).json()).count, 0);
  assert.equal(
    (await s.request("checkout/confirm", { quoteId: quote.id }, newSession.cookie)).status,
    200,
  );
});

test("competing buyers cannot both consume last stock, and unavailable items remain removable", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  s.commerce.importCatalog([{ ...fixtureProducts[0], stock: 1 }]);
  const other = await s.authenticate("buyer", "buyer-password");
  const cookie = other.cookie;
  for (const identity of [s.cookie, cookie])
    assert.equal(
      (
        await s.request(
          "cart/quantity",
          { product_id: "coffee", quantity: 1, expectedRevision: 0 },
          identity,
        )
      ).status,
      200,
    );
  const a = await (await s.request("checkout/quote", {})).json();
  const b = await (await s.request("checkout/quote", {}, cookie)).json();
  const [one, two] = await Promise.all([
    s.request("checkout/confirm", { quoteId: a.id }),
    s.request("checkout/confirm", { quoteId: b.id }, cookie),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(s.commerce.catalog().products[0].stock, 0);
  assert.equal((await (await s.request("cart", undefined, cookie)).json()).count, 1);
  s.commerce.importCatalog([{ ...fixtureProducts[0], stock: 0, active: false }]);
  assert.equal(
    (
      await s.request(
        "cart/quantity",
        { product_id: "coffee", quantity: 0, expectedRevision: 1 },
        cookie,
      )
    ).status,
    200,
  );
});

test("catalog import validates whole files and persistent carts survive reopening, with expired sessions denied", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-commerce-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  let runtime = await createRuntime({ path, secret: testSecret, baseURL: "http://localhost" });
  let c = runtime.commerce;
  t.after(() => runtime.close());
  assert.equal(c.catalog().products.length, 0);
  c.importCatalog(fixtureProducts);
  for (const rows of [
    [{ ...fixtureProducts[0], priceCents: -1 }],
    [{ ...fixtureProducts[0], priceCents: 0.1 }],
    [{ ...fixtureProducts[0], stock: 1_000_001 }],
    [{ ...fixtureProducts[0], priceCents: Number.MAX_SAFE_INTEGER }],
    [fixtureProducts[0], fixtureProducts[0]],
    [fixtureProducts[0], { ...fixtureProducts[1], currency: "USD" }],
  ])
    assert.throws(() => c.importCatalog(rows));
  assert.equal(c.catalog().products.length, 2);
  const response = await runtime.handle(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "x-real-ip": "192.0.2.201",
      },
      body: JSON.stringify({
        username: "persistent",
        name: "persistent",
        email: "persistent@example.com",
        password: "persistent-password",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const headers = new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .join("; "),
  });
  const session = await sessionIdentity(runtime, headers);
  assert.ok(session);
  c.setQuantity(session, { product_id: "plant", quantity: 3, expectedRevision: 0 });
  await runtime.close();
  runtime = await createRuntime({ path, secret: testSecret, baseURL: "http://localhost" });
  c = runtime.commerce;
  assert.equal(c.cart(session.userId).totalCents, 5400);
  assert.ok(await sessionIdentity(runtime, headers));
  const maintenance = new DatabaseSync(path);
  maintenance.prepare("UPDATE sessions SET expiresAt=?").run(new Date(0).toISOString());
  maintenance.close();
  assert.equal(await sessionIdentity(runtime, headers), null);
  assert.throws(() => c.prepareCheckout(session), /Sign in/);
});

test("a failed order write rolls back stock and cart changes, allowing the same review to be retried", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-commerce-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  const s = await fixture(path);
  t.after(() => s.runtime.close());
  await s.request("cart/quantity", { product_id: "coffee", quantity: 2, expectedRevision: 0 });
  const quote = await (await s.request("checkout/quote", {})).json();
  const maintenance = new DatabaseSync(path);
  t.after(() => maintenance.close());
  maintenance.exec(
    "CREATE TRIGGER reject_order BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'write failure'); END",
  );
  assert.equal((await s.request("checkout/confirm", { quoteId: quote.id })).status, 500);
  assert.equal(s.commerce.catalog().products[0].stock, 10);
  assert.equal((await (await s.request("cart")).json()).totalCents, 1000);
  assert.equal(maintenance.prepare("SELECT COUNT(*) count FROM orders").get()?.count, 0);
  maintenance.exec("DROP TRIGGER reject_order");
  assert.equal((await s.request("checkout/confirm", { quoteId: quote.id })).status, 200);
  assert.equal(s.commerce.catalog().products[0].stock, 8);
});

test("revoking a session during upload prevents checkout and model calls", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => {
    throw new Error("A revoked session must not reach Gateway");
  });
  for (const path of ["checkout/confirm", "generate"]) {
    await t.test(path, async (t) => {
      const s = await fixture();
      t.after(() => s.runtime.close());
      await s.request("cart/quantity", {
        product_id: "coffee",
        quantity: 1,
        expectedRevision: 0,
      });
      const quote = await (await s.request("checkout/quote", {})).json();
      const upload = s.delayedPost(
        path,
        path === "generate"
          ? { prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }
          : { quoteId: quote.id },
      );
      await new Promise((resolve) => setImmediate(resolve));
      await s.request("auth/sign-out", {});
      upload.release();
      assert.equal((await upload.response).status, 401);
      assert.equal(s.commerce.catalog().products[0].stock, 10);
    });
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("a cart above current stock can step down but not up", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const set = (quantity: number, expectedRevision: number) =>
    s.request("cart/quantity", { product_id: "coffee", quantity, expectedRevision });
  const added = await set(5, 0);
  assert.equal(added.status, 200);
  const { revision } = await added.json();
  s.runtime.commerce.importCatalog([{ ...fixtureProducts[0], stock: 2 }]);
  assert.equal((await set(6, revision)).status, 409);
  const lowered = await set(4, revision);
  assert.equal(lowered.status, 200);
  assert.equal((await lowered.json()).count, 4);
  assert.equal((await s.request("checkout/quote", {})).status, 409);
});

test("a new database and its WAL are private even in an existing shared directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-database-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const path = join(directory, "app.sqlite");
  const db = openDatabase(path);
  db.exec("CREATE TABLE probe(x)");
  for (const file of [path, `${path}-wal`]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  db.close();
});

test("opening an existing database makes its readable file and leftover WAL private and keeps its data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-database-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  const existing = new DatabaseSync(path);
  t.after(() => existing.close());
  existing.exec("PRAGMA journal_mode=WAL; CREATE TABLE probe(x); INSERT INTO probe VALUES (1)");
  for (const file of [path, `${path}-wal`]) await chmod(file, 0o644);
  const db = openDatabase(path);
  t.after(() => db.close());
  for (const file of [path, `${path}-wal`]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual({ ...db.prepare("SELECT x FROM probe").get() }, { x: 1 });
});
