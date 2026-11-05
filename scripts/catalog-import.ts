import { readFile } from "node:fs/promises";
import { createCommerce, databasePath, openDatabase } from "../src/lib/server/commerce.ts";

const file = process.argv[2];
if (!file || process.argv.length !== 3)
  throw new Error(
    "Usage: task catalog-import FILE=products.json. Supply an array of {id,name,emoji,currency:'EUR',priceCents,stock,active?:boolean}. Supplied stock replaces current inventory; omitted products are untouched.",
  );
const rows: unknown = JSON.parse(await readFile(file, "utf8"));
const db = openDatabase(databasePath(process.env.FX_DATABASE_PATH));
try {
  process.stdout.write(`Imported ${createCommerce(db).importCatalog(rows)} products.\n`);
} finally {
  db.close();
}
