import { DatabaseSync } from "node:sqlite";
import { envDefaults } from "./env-defaults.ts";
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  cartSchema,
  catalogImportSchema,
  catalogSchema,
  lineSchema,
  orderSchema,
  productSchema,
  quoteSchema,
  type mutationSchema,
  type Cart,
  ApiError,
} from "../contract.ts";

// Runtime callers serialize access to the shared connection. Keep transaction
// callbacks synchronous so no auth or commerce work can interleave before commit.
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const commerceSql = {
  schema: `
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='EUR'), priceCents INTEGER NOT NULL CHECK(priceCents BETWEEN 0 AND 1000000000), stock INTEGER NOT NULL CHECK(stock BETWEEN 0 AND 1000000), active INTEGER NOT NULL CHECK(active IN (0,1)));
    CREATE TABLE IF NOT EXISTS carts(userId TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cart_items(userId TEXT NOT NULL REFERENCES carts(userId), productId TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99), PRIMARY KEY(userId,productId));
    CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), sessionId TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, quoteId TEXT UNIQUE NOT NULL REFERENCES quotes(id), userId TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL);`,
  catalog: "SELECT * FROM products WHERE active=1 ORDER BY id",
  ensureCart: "INSERT OR IGNORE INTO carts(userId) VALUES(?)",
  cartRevision: "SELECT revision FROM carts WHERE userId=?",
  cartItems:
    "SELECT p.*,c.quantity FROM cart_items c JOIN products p ON p.id=c.productId WHERE c.userId=? ORDER BY p.id",
  activeSession: "SELECT id FROM sessions WHERE id=? AND userId=? AND expiresAt>?",
  product: "SELECT * FROM products WHERE id=?",
  removeCartItem: "DELETE FROM cart_items WHERE userId=? AND productId=?",
  setCartQuantity:
    "INSERT INTO cart_items VALUES(?,?,?) ON CONFLICT(userId,productId) DO UPDATE SET quantity=excluded.quantity",
  bumpCartRevision: "UPDATE carts SET revision=revision+1 WHERE userId=?",
  insertQuote: "INSERT INTO quotes VALUES(?,?,?,?)",
  orderForQuote: "SELECT snapshot FROM orders WHERE quoteId=? AND userId=?",
  quoteForUser: "SELECT userId,sessionId,snapshot FROM quotes WHERE id=? AND userId=?",
  deductStock:
    "UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND priceCents=? AND stock>=?",
  insertOrder: "INSERT INTO orders VALUES(?,?,?,?)",
  clearCart: "DELETE FROM cart_items WHERE userId=?",
  productCount: "SELECT COUNT(*) count FROM products",
  productExists: "SELECT id FROM products WHERE id=?",
  importProduct:
    "INSERT INTO products VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,emoji=excluded.emoji,currency=excluded.currency,priceCents=excluded.priceCents,stock=excluded.stock,active=excluded.active",
};

export const databasePath = (configured?: string) =>
  resolve(configured || envDefaults.FX_DATABASE_PATH);
export type Identity = { userId: string; sessionId: string; delegation?: never };
export type DelegatedIdentity = {
  userId: string;
  sessionId: string;
  delegation: { expiresAt: number; scopes: readonly string[] };
};
export type ShopIdentity = Identity | DelegatedIdentity;
const quoteRow = z.object({ userId: z.string(), sessionId: z.string(), snapshot: z.string() });
const orderRow = z.object({ snapshot: z.string() });

export function openDatabase(path: string) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // The directory may predate mkdir's mode, so create the file private before SQLite does.
    // SQLite gives new WAL and SHM files this mode. Tighten only files left readable.
    closeSync(openSync(path, "a", 0o600));
    for (const file of [path, `${path}-wal`, `${path}-shm`])
      if ((statSync(file, { throwIfNoEntry: false })?.mode ?? 0) & 0o077) chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  return db;
}

export function createCommerce(db: DatabaseSync) {
  db.exec(commerceSql.schema);
  function catalog() {
    return catalogSchema.parse({
      currency: "EUR",
      products: db
        .prepare(commerceSql.catalog)
        .all()
        .map((row) => productSchema.parse({ ...row, active: Boolean(row.active) })),
    });
  }
  function cart(userId: string): Cart {
    db.prepare(commerceSql.ensureCart).run(userId);
    const revision = z
      .object({ revision: z.number() })
      .parse(db.prepare(commerceSql.cartRevision).get(userId)).revision;
    // Cart lines use current catalog prices. Quotes and orders instead retain
    // snapshots, so confirmation must compare the quote with these current values.
    const items = db
      .prepare(commerceSql.cartItems)
      .all(userId)
      .map((row) => {
        const { quantity: storedQuantity, ...fields } = row;
        const product = productSchema.parse({ ...fields, active: Boolean(row.active) });
        const quantity = z.number().int().parse(storedQuantity);
        return lineSchema.parse({
          ...product,
          quantity,
          lineTotalCents: product.priceCents * quantity,
        });
      });
    const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    return cartSchema.parse({
      revision,
      currency: "EUR",
      items,
      count: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotalCents,
      totalCents: subtotalCents,
    });
  }
  // Token verification alone does not prove that its session is still active.
  // Recheck session, expiry, and delegated scope inside each protected transaction.
  function requireSession(who: ShopIdentity, scope: "shop:read" | "shop:write") {
    if (who.delegation) {
      if (who.delegation.expiresAt <= Date.now())
        throw new ApiError("Authorization expired. Connect again.", 401);
      if (!who.delegation.scopes.includes(scope))
        throw new ApiError("Authorization does not permit this operation.", 403);
    }
    if (
      !db
        .prepare(commerceSql.activeSession)
        .get(who.sessionId, who.userId, new Date().toISOString())
    )
      throw new ApiError("Sign in to continue.", 401);
  }
  function setQuantity(who: ShopIdentity, input: z.infer<typeof mutationSchema>) {
    return transaction(db, () => {
      requireSession(who, "shop:write");
      const current = cart(who.userId);
      if (current.revision !== input.expectedRevision)
        throw new ApiError("Cart changed. Review its current quantities and try again.", 409, {
          cart: current,
        });
      const existing = current.items.find((item) => item.id === input.product_id);
      // Only an increase needs an active product with stock, so a user can always
      // lower or remove an item that sold out or was withdrawn.
      if (input.quantity > (existing?.quantity ?? 0)) {
        const row = db.prepare(commerceSql.product).get(input.product_id);
        if (!row) throw new ApiError("Unknown product.", 404);
        const product = productSchema.parse({ ...row, active: Boolean(row.active) });
        if (!product.active || product.stock < input.quantity)
          throw new ApiError("Product is unavailable or has insufficient stock.", 409);
      }
      if ((existing?.quantity ?? 0) !== input.quantity) {
        if (input.quantity === 0)
          db.prepare(commerceSql.removeCartItem).run(who.userId, input.product_id);
        else
          db.prepare(commerceSql.setCartQuantity).run(who.userId, input.product_id, input.quantity);
        db.prepare(commerceSql.bumpCartRevision).run(who.userId);
      }
      return cart(who.userId);
    });
  }
  function available(current: Cart) {
    if (!current.items.length) throw new ApiError("Your cart is empty.", 409);
    if (current.items.some((item) => !item.active || item.stock < item.quantity))
      throw new ApiError("Stock changed. Update your cart and review again.", 409, {
        cart: current,
      });
  }
  function prepareCheckout(who: Identity) {
    return transaction(db, () => {
      requireSession(who, "shop:write");
      const current = cart(who.userId);
      available(current);
      const quote = quoteSchema.parse({
        ...current,
        id: randomUUID(),
        expiresAt: Date.now() + 5 * 60_000,
      });
      db.prepare(commerceSql.insertQuote).run(
        quote.id,
        who.userId,
        who.sessionId,
        JSON.stringify(quote),
      );
      return quote;
    });
  }
  function confirmCheckout(who: Identity, quoteId: string) {
    return transaction(db, () => {
      requireSession(who, "shop:write");
      // A successful confirmation clears the cart. Return its recorded order on
      // retry before checking whether the old quote still matches the current cart.
      const prior = db.prepare(commerceSql.orderForQuote).get(quoteId, who.userId);
      if (prior) return orderSchema.parse(JSON.parse(orderRow.parse(prior).snapshot));
      const row = db.prepare(commerceSql.quoteForUser).get(quoteId, who.userId);
      if (!row) throw new ApiError("Review an order before confirming it.", 404);
      const stored = quoteRow.parse(row);
      const quote = quoteSchema.parse(JSON.parse(stored.snapshot));
      const current = cart(who.userId);
      if (
        stored.sessionId !== who.sessionId ||
        quote.expiresAt <= Date.now() ||
        current.revision !== quote.revision
      )
        throw new ApiError("Review expired or cart changed. Review your order again.", 409, {
          cart: current,
        });
      available(current);
      if (
        current.totalCents !== quote.totalCents ||
        current.items.length !== quote.items.length ||
        current.items.some(
          (item, index) =>
            item.id !== quote.items[index].id ||
            item.quantity !== quote.items[index].quantity ||
            item.priceCents !== quote.items[index].priceCents,
        )
      )
        throw new ApiError("Prices changed. Review your order again.", 409, { cart: current });
      // Stock deductions, the order receipt, and cart clearing commit together.
      // Any failed deduction or order write rolls the whole checkout back.
      for (const item of current.items) {
        const deducted = db
          .prepare(commerceSql.deductStock)
          .run(item.quantity, item.id, item.priceCents, item.quantity);
        if (deducted.changes !== 1)
          throw new ApiError("Stock changed. Review your order again.", 409);
      }
      const order = orderSchema.parse({
        revision: quote.revision,
        currency: quote.currency,
        items: quote.items,
        count: quote.count,
        subtotalCents: quote.subtotalCents,
        totalCents: quote.totalCents,
        id: randomUUID(),
        createdAt: Date.now(),
      });
      db.prepare(commerceSql.insertOrder).run(order.id, quoteId, who.userId, JSON.stringify(order));
      db.prepare(commerceSql.clearCart).run(who.userId);
      db.prepare(commerceSql.bumpCartRevision).run(who.userId);
      return order;
    });
  }
  function importCatalog(input: unknown) {
    const rows = catalogImportSchema.parse(input);
    transaction(db, () => {
      const existing = z
        .object({ count: z.number() })
        .parse(db.prepare(commerceSql.productCount).get()).count;
      const newCount = rows.filter(
        (row) => !db.prepare(commerceSql.productExists).get(row.id),
      ).length;
      if (existing + newCount > 1000)
        throw new ApiError("Catalog supports at most 1000 products.", 400);
      for (const row of rows)
        db.prepare(commerceSql.importProduct).run(
          row.id,
          row.name,
          row.emoji,
          row.currency,
          row.priceCents,
          row.stock,
          Number(row.active),
        );
    });
    return rows.length;
  }
  return {
    catalog,
    cart,
    catalogFor: (who: ShopIdentity) =>
      transaction(db, () => {
        requireSession(who, "shop:read");
        return catalog();
      }),
    cartFor: (who: ShopIdentity) =>
      transaction(db, () => {
        requireSession(who, "shop:read");
        return cart(who.userId);
      }),
    setQuantity,
    prepareCheckout,
    confirmCheckout,
    importCatalog,
  };
}
