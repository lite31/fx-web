import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { databasePath } from "../src/lib/server/commerce.ts";

const from = process.argv[2];
if (!from || process.argv.length !== 3)
  throw new Error(
    "Usage: task database-migrate FROM=/path/to/existing.sqlite. Stop all database users first. The source is retained.",
  );
const target = databasePath(process.env.FX_DATABASE_PATH);
if (resolve(from) === target) throw new Error("Source and destination must differ.");
for (const suffix of ["", "-wal", "-shm", "-journal"])
  if (lstatSync(target + suffix, { throwIfNoEntry: false }))
    throw new Error("Destination or SQLite sidecar exists. Nothing was replaced.");
const source = new DatabaseSync(from, { readOnly: true });
try {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(target), ".database-migrate-"));
  try {
    const snapshot = join(staging, "app.sqlite");
    // SQLite backup includes committed WAL data. Copying the main file alone can
    // miss writes that have not yet been checkpointed into it.
    await backup(source, snapshot);
    const db = new DatabaseSync(snapshot, { readOnly: true });
    try {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw new Error("Database integrity check failed. Source is unchanged.");
    } finally {
      db.close();
    }
    chmodSync(snapshot, 0o600);
    // Publish without overwriting a destination created after the initial check.
    // Staging beside the target keeps this hard link on the same filesystem.
    linkSync(snapshot, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
} finally {
  source.close();
}
console.log("Database migrated. Source retained; restart the server before making changes.");
