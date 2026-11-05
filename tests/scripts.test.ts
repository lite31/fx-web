import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { envDefaults } from "../src/lib/server/env-defaults.ts";

test("the environment template documents the server's defaults", async () => {
  const template = parseEnv(await readFile(new URL("../.env.fx.example", import.meta.url), "utf8"));
  for (const [name, value] of Object.entries(envDefaults))
    assert.equal(
      template[name],
      value,
      `${name} in .env.fx.example differs from the server default`,
    );
  assert.equal(
    template.BETTER_AUTH_SECRET,
    undefined,
    "keep BETTER_AUTH_SECRET commented out in .env.fx.example, or auth-setup skips creating one",
  );
});

test("catalog CLI imports into its configured database and rejects invalid input without changing inventory", async (t) => {
  for (const configured of [false, true])
    await t.test(configured ? "override" : "default", async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "fx-catalog-cli-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const database = join(directory, configured ? "custom.sqlite" : "data/app.sqlite");
      const file = join(directory, "products.json");
      const script = new URL("../scripts/catalog-import.ts", import.meta.url);
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [fileURLToPath(script), ...args], {
          cwd: directory,
          env: { ...process.env, FX_DATABASE_PATH: configured ? database : "" },
          encoding: "utf8",
          timeout: 10_000,
        });
      await writeFile(
        file,
        JSON.stringify([
          {
            id: "coffee",
            name: "Coffee",
            emoji: "☕",
            currency: "EUR",
            priceCents: 500,
            stock: 10,
          },
        ]),
      );
      const imported = run(file);
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stdout, "Imported 1 products.\n");
      const db = new DatabaseSync(database);
      try {
        assert.deepEqual(
          { ...db.prepare("SELECT priceCents,stock,active FROM products WHERE id='coffee'").get() },
          { priceCents: 500, stock: 10, active: 1 },
        );
        const initial = db.prepare("SELECT * FROM products").all();
        for (const args of [[], [file, "extra"], [join(directory, "missing.json")]]) {
          const result = run(...args);
          assert.equal(result.status, 1);
          assert.equal(result.stdout, "");
          assert.ok(result.stderr.length > 0);
        }
        for (const content of [
          "{",
          JSON.stringify([
            {
              id: "coffee",
              name: "Coffee",
              emoji: "☕",
              currency: "EUR",
              priceCents: 600,
              stock: 2,
            },
            { id: "plant", name: "Plant", emoji: "🪴", currency: "EUR", priceCents: -1, stock: 1 },
          ]),
        ]) {
          await writeFile(file, content);
          const rejected = run(file);
          assert.equal(rejected.status, 1);
          assert.equal(rejected.stdout, "");
          assert.ok(rejected.stderr.length > 0);
          assert.deepEqual(db.prepare("SELECT * FROM products").all(), initial);
        }
      } finally {
        db.close();
      }
    });
});

test("database migration copies committed WAL data and refuses unsafe destinations without changing its source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-database-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.sqlite");
  const target = join(directory, "data/app.sqlite");
  const db = new DatabaseSync(source);
  t.after(() => db.close());
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE retained (id INTEGER PRIMARY KEY, secret TEXT, bytes BLOB); INSERT INTO retained VALUES (1, 'keep-me', X'00FF'); CREATE INDEX retained_secret ON retained(secret)",
  );
  const expected = db.prepare("SELECT * FROM retained").all();
  const script = fileURLToPath(new URL("../scripts/database-migrate.ts", import.meta.url));
  const run = (from = source, override = "", extra: string[] = []) =>
    spawnSync(process.execPath, [script, from, ...extra], {
      cwd: directory,
      env: { ...process.env, FX_DATABASE_PATH: override },
      encoding: "utf8",
      timeout: 10_000,
    });
  const migrated = run();
  assert.equal(migrated.status, 0, migrated.stderr);
  const copied = new DatabaseSync(target, { readOnly: true });
  try {
    assert.deepEqual(copied.prepare("SELECT * FROM retained").all(), expected);
    assert.equal(copied.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(
      copied.prepare("SELECT name FROM sqlite_master WHERE type='index'").get()?.name,
      "retained_secret",
    );
  } finally {
    copied.close();
  }
  const before = await readFile(target);
  assert.equal(run().status, 1);
  assert.deepEqual(await readFile(target), before);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const blocked = join(directory, "blocked.sqlite");
    await writeFile(blocked + suffix, "retained-sidecar");
    assert.equal(run(source, blocked).status, 1);
    assert.equal(await readFile(blocked + suffix, "utf8"), "retained-sidecar");
    await rm(blocked + suffix);
  }
  const dangling = join(directory, "dangling.sqlite");
  await symlink(join(directory, "missing.sqlite"), dangling);
  assert.equal(run(source, dangling).status, 1);
  assert.equal(run(source, source).status, 1);
  assert.equal(run(join(directory, "absent.sqlite"), join(directory, "unused.sqlite")).status, 1);
  assert.equal(run(source, join(directory, "extra.sqlite"), ["extra"]).status, 1);
  const custom = join(directory, "overridden.sqlite");
  assert.equal(run(source, custom).status, 0);
  const overridden = new DatabaseSync(custom, { readOnly: true });
  try {
    assert.deepEqual(overridden.prepare("SELECT * FROM retained").all(), expected);
  } finally {
    overridden.close();
  }
  assert.deepEqual(db.prepare("SELECT * FROM retained").all(), expected);
});

test("auth setup handles missing files, newline boundaries, preserves credentials on rerun, and reports read failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-setup-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, ".env.fx");
  const script = new URL("../scripts/auth-setup.ts", import.meta.url);
  const run = () =>
    spawnSync(process.execPath, [fileURLToPath(script)], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
  const fresh = run();
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.stdout, "");
  const { stat, mkdir } = await import("node:fs/promises");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(file, "utf8"), /^BETTER_AUTH_SECRET=[A-Za-z0-9_-]{43}\n$/);
  await writeFile(file, "AI_GATEWAY_API_KEY=fixture-only\nFX_MODEL=fixture");
  await chmod(file, 0o644);
  const appended = run();
  assert.equal(appended.status, 0, appended.stderr);
  assert.equal(appended.stdout, "");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const initial = await readFile(file, "utf8");
  assert.match(
    initial,
    /^AI_GATEWAY_API_KEY=fixture-only\nFX_MODEL=fixture\nBETTER_AUTH_SECRET=[A-Za-z0-9_-]{43}\n$/,
  );
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, "");
  assert.equal(await readFile(file, "utf8"), initial);
  const existing = "FX_MODEL=fixture\n export BETTER_AUTH_SECRET=keep-me";
  await writeFile(file, existing);
  const unchanged = run();
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.stdout, "");
  assert.equal(await readFile(file, "utf8"), existing);
  await rm(file);
  await mkdir(file);
  const failed = run();
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.ok(failed.stderr.length > 0);
});
