import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { request } from "node:http";
import { freePort, startTask, waitForReady } from "./fixtures/process.mjs";

async function server(t, secret = "route-fixture-secret-at-least-32-characters") {
  const directory = await mkdtemp(join(tmpdir(), "fx-routes-"));
  let child;
  t.after(async () => {
    try {
      await child?.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const path = join(directory, "app.sqlite");
  child = startTask(
    ["serve", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      env: {
        ...process.env,
        FX_DATABASE_PATH: path,
        BETTER_AUTH_URL: "",
        BETTER_AUTH_SECRET: secret,
        AI_GATEWAY_API_KEY: "fixture-only",
      },
    },
  );
  await waitForReady([child], async (signal) => {
    await fetch(`${origin}/api/config`, { signal });
    return true;
  });
  return { origin, path };
}

const cookieFrom = (response) =>
  response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");

function page(origin, path, cookie = "") {
  return fetch(`${origin}${path}`, { redirect: "manual", headers: { cookie } });
}

function redirectTo(response, location) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), location);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("real page guards redirect guests and accounts, forward refresh/deletion cookies and never serialize session tokens", async (t) => {
  const { origin, path } = await server(t);
  redirectTo(await page(origin, "/"), "/sign-in");
  const signin = await page(origin, "/sign-in");
  assert.equal(signin.status, 200);
  assert.equal(signin.headers.get("cache-control"), "no-store");
  assert.match(await signin.text(), /Sign in to fx-web/);
  const created = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      username: "route_user",
      name: "Route user",
      email: "route@example.com",
      password: "route-user-password",
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const cookie = cookieFrom(created);
  const { token, user } = await created.json();
  assert.equal(typeof token, "string");
  const main = await page(origin, "/", cookie);
  assert.equal(main.status, 200);
  assert.equal(main.headers.get("cache-control"), "no-store");
  const html = await main.text();
  assert.equal(html.includes(token), false);
  assert.equal(html.includes("session_token"), false);
  assert.equal(html.includes('autocomplete="current-password"'), false);
  redirectTo(await page(origin, "/sign-in", cookie), "/");
  const data = await page(origin, "/__data.json", cookie);
  assert.equal(data.status, 200);
  assert.equal(data.headers.get("cache-control"), "no-store");
  assert.equal((await data.text()).includes(token), false);

  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("UPDATE users SET id = ? WHERE id = ?").run("invalid+", user.id);
  db.prepare("UPDATE sessions SET userId = ? WHERE userId = ?").run("invalid+", user.id);
  for (const route of ["/", "/sign-in"]) {
    const malformed = await page(origin, route, cookie);
    assert.equal(malformed.status, 503);
    assert.equal(malformed.headers.has("location"), false);
    assert.equal((await malformed.text()).includes(token), false);
  }
  db.prepare("UPDATE users SET id = ? WHERE id = ?").run(user.id, "invalid+");
  db.prepare("UPDATE sessions SET userId = ? WHERE userId = ?").run(user.id, "invalid+");
  db.prepare("UPDATE sessions SET expiresAt = ?").run(Date.now() + 5 * 24 * 60 * 60_000);
  const refreshed = await page(origin, "/sign-in", cookie);
  redirectTo(refreshed, "/");
  assert.match(refreshed.headers.get("set-cookie") ?? "", /better-auth\.session_token=/);
  db.prepare("UPDATE sessions SET expiresAt = ?").run(Date.now() - 1000);
  const expired = await page(origin, "/", cookie);
  redirectTo(expired, "/sign-in");
  assert.match(expired.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await page(origin, "/api/cart", cookie)).status, 401);
});

test("page guards fail closed when the native session lookup fails", async (t) => {
  const { origin } = await server(t, "");
  for (const path of ["/", "/sign-in"]) {
    const response = await page(origin, path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.has("location"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /Unable to check your account/);
  }
});

test("protocol routes rate-limit by socket address and refuse non-loopback hosts", async (t) => {
  const { origin } = await server(t);
  const statuses = [];
  for (let index = 0; index < 125; index++)
    statuses.push(
      (
        await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
          headers: { "x-real-ip": `198.51.100.${index}` },
        })
      ).status,
    );
  assert.equal(statuses[0], 200);
  assert.equal(statuses.at(-1), 429);
  const { port } = new URL(origin);
  for (const path of ["/mcp", "/.well-known/oauth-protected-resource", "/api/config"]) {
    const status = await new Promise((resolve, reject) =>
      request(
        { host: "127.0.0.1", port, path, headers: { host: `example.com:${port}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
        .on("error", reject)
        .end(),
    );
    assert.equal(status, 403, path);
  }
});
