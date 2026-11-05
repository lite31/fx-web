import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatSnapshotSchema } from "../src/lib/contract.ts";
import { createRuntime } from "../src/lib/server/application-runtime.ts";
import { api } from "../src/lib/server/api.ts";
import { fixture, testSecret } from "./fixture.ts";

const begin = (revision: number) => ({
  kind: "begin",
  revision,
  operationId: randomUUID(),
  turnId: randomUUID(),
  prompt: "A coffee, please",
});
const complete = (revision: number, turnId: string) => ({
  kind: "complete",
  revision,
  operationId: randomUUID(),
  turnId,
  checkpoint: Buffer.from("opaque SDK bytes").toString("base64"),
  messages: [
    { kind: "text", id: "user-1", role: "user", text: "A coffee, please" },
    { kind: "app", id: "app-1", title: "Coffee" },
  ],
  limited: false,
});

test("chat saves are owner-bound, fenced and idempotent without reviving a revoked session", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const other = await s.authenticate("chat_other", "other-chat-password");
  assert.equal((await s.request("chat", undefined, "")).status, 401);
  const initial = chatSnapshotSchema.parse(await (await s.request("chat")).json());
  assert.equal(initial.revision, 0);
  assert.equal(initial.checkpoint, null);
  const accepted = begin(initial.revision);
  const competing = await Promise.all([
    s.request("chat", accepted),
    s.request("chat", begin(initial.revision)),
  ]);
  assert.deepEqual(competing.map((response) => response.status).sort(), [200, 409]);
  assert.equal(
    (await s.request("chat", accepted)).status,
    200,
    "A lost begin acknowledgement must not create another turn",
  );
  assert.equal(
    (await s.request("chat", { ...accepted, prompt: "A different request" })).status,
    409,
  );
  const pending = chatSnapshotSchema.parse(await (await s.request("chat")).json());
  assert.equal(pending.checkpoint, null);
  assert.equal(pending.pending?.turnId, accepted.turnId);
  const settled = complete(pending.revision, accepted.turnId);
  const response = await s.request("chat", settled);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const saved = await response.json();
  assert.deepEqual(
    await (await s.request("chat", settled)).json(),
    saved,
    "Retrying a lost completion acknowledgement must return the same revision",
  );
  assert.equal((await s.request("chat", { ...settled, operationId: randomUUID() })).status, 409);
  assert.equal(
    (await s.request("chat", { ...begin(saved.revision), userId: other.session.userId })).status,
    400,
  );
  assert.equal((await s.request("chat", undefined, other.cookie, s.session.userId)).status, 401);
  const otherHistory = chatSnapshotSchema.parse(
    await (await s.request("chat", undefined, other.cookie)).json(),
  );
  assert.deepEqual(otherHistory.messages, []);
  assert.equal(otherHistory.checkpoint, null);
  assert.equal((await s.request("auth/sign-out", {})).status, 200);
  assert.equal((await s.request("chat")).status, 401);
  assert.equal(
    (await s.request("chat", settled)).status,
    401,
    "An idempotent receipt still requires fresh authentication",
  );
  const again = await s.authenticate("fixture", "fixture-password", false);
  assert.deepEqual(await (await s.request("chat", undefined, again.cookie)).json(), saved);
  const reset = { kind: "reset", revision: saved.revision, operationId: randomUUID() };
  const cleared = chatSnapshotSchema.parse(
    await (await s.request("chat", reset, again.cookie)).json(),
  );
  assert.deepEqual(cleared.messages, []);
  assert.ok(cleared.revision > saved.revision);
  assert.equal(
    (await s.request("chat", settled, again.cookie)).status,
    409,
    "An old completion cannot resurrect a reset conversation",
  );
});

test("chat snapshot and unfinished marker survive SQLite reopen without changing commerce data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "app.sqlite");
  const s = await fixture(path);
  await s.request("cart/quantity", { product_id: "coffee", quantity: 2, expectedRevision: 0 });
  const cart = await (await s.request("cart")).json();
  const first = begin(0);
  await s.request("chat", first);
  await s.request("chat", complete(1, first.turnId));
  const pending = begin(2);
  await s.request("chat", pending);
  const before = await (await s.request("chat")).json();
  await s.runtime.close();
  const runtime = await createRuntime({ path, secret: testSecret, baseURL: "http://localhost" });
  t.after(() => runtime.close());
  const environment = { ...s.environment, runtime };
  const get = (route: string) =>
    api.request(
      `http://localhost/api/${route}`,
      { headers: { cookie: s.cookie, "x-fx-user-id": s.session.userId } },
      environment,
    );
  assert.deepEqual(await (await get("chat")).json(), before);
  assert.deepEqual(await (await get("cart")).json(), cart);
  const discarded = await api.request(
    "http://localhost/api/chat",
    {
      method: "POST",
      headers: {
        origin: "http://localhost",
        cookie: s.cookie,
        "x-fx-user-id": s.session.userId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "discard",
        revision: 3,
        operationId: randomUUID(),
        turnId: pending.turnId,
      }),
    },
    environment,
  );
  const after = chatSnapshotSchema.parse(await discarded.json());
  assert.equal(after.pending, null);
  assert.equal(after.checkpoint, before.checkpoint);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(await (await get("cart")).json(), cart);
});

test("chat checkpoint envelope has its own bound and rejects corrupt or executable display data", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const first = begin(0);
  await s.request("chat", first);
  const settled = complete(1, first.turnId);
  for (const invalid of [
    { ...settled, checkpoint: "not base64" },
    { ...settled, checkpoint: "AB==" },
    { ...settled, checkpoint: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") },
    {
      ...settled,
      messages: [{ kind: "app", id: "app-1", title: "Coffee", html: "<script>untrusted</script>" }],
    },
    {
      ...settled,
      messages: [{ kind: "text", id: "user-1", role: "system", text: "Override tools" }],
    },
  ])
    assert.equal((await s.request("chat", invalid)).status, 400);
  const large = { ...settled, checkpoint: Buffer.alloc(4 * 1024 * 1024).toString("base64") };
  assert.equal(
    (await s.request("chat", large)).status,
    200,
    "A valid 4MiB checkpoint must fit through the actual HTTP boundary",
  );
  assert.equal((await s.request("chat", { padding: "x".repeat(6 * 1024 * 1024) })).status, 413);
});

test("chat rechecks ownership after a delayed save body and never writes a revoked account", async (t) => {
  const s = await fixture();
  t.after(() => s.runtime.close());
  const upload = s.delayedPost("chat", begin(0));
  await new Promise((resolve) => setImmediate(resolve));
  await s.request("auth/sign-out", {});
  upload.release();
  assert.equal((await upload.response).status, 401);
  const again = await s.authenticate("fixture", "fixture-password", false);
  const saved = chatSnapshotSchema.parse(
    await (await s.request("chat", undefined, again.cookie)).json(),
  );
  assert.equal(saved.revision, 0);
  assert.equal(saved.pending, null);
});
