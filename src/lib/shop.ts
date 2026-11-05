import { z } from "zod";
import { createAccount, type Account, type AccountRequest } from "./account.ts";
import {
  ApiError,
  cartSchema,
  catalogSchema,
  sessionSchema,
  emptySchema,
  quantitySchema,
  quoteSchema,
  orderSchema,
  shopTools,
  type Cart,
  type Product,
  type User,
  type Quote,
  type Order,
} from "./contract.ts";
export type ShopView = {
  user: User | null;
  cart: Cart | null;
  products: Product[];
  loading: boolean;
  busy: boolean;
  quote: Quote | null;
  order: Order | null;
  refreshWarning: string;
};

export function createShopView(): ShopView {
  return {
    user: null,
    cart: null,
    products: [],
    loading: true,
    busy: false,
    quote: null,
    order: null,
    refreshWarning: "",
  };
}

// UI controls, fx callbacks, and WebMCP tools use this account-bound view and
// write queue. The backend remains authoritative for cart contents and totals.
export function createShop(onChange: (view: ShopView) => void) {
  let view = createShopView();
  let logoutUserId: string | undefined;
  let cartRequest = 0;
  let catalogRequest = 0;
  let publishedCatalogRequest = 0;
  let refreshWarningRevision = 0;
  // clearIdentity replaces an aborted lifetime at once, so only dispose() leaves it aborted.
  let lifetime = new AbortController();
  let writes: Promise<unknown> = Promise.resolve();
  const closed = () => new DOMException("Account changed or shop closed.", "AbortError");
  const publish = () => {
    if (!lifetime.signal.aborted) onChange({ ...view });
  };
  function account(userId = view.user?.id): Account {
    const signal = lifetime.signal;
    return createAccount({
      userId,
      signal,
      onUnauthorized: (path) => {
        if (path !== "auth/get-session") invalidateIdentity(signal);
      },
    });
  }
  // Abort active requests and every captured Account, including queued writes
  // that have not started. Aborting alone cannot reject already resolved work.
  function clearIdentity() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(closed());
    lifetime = new AbortController();
    writes = Promise.resolve();
    view = createShopView();
    publish();
  }
  function invalidateIdentity(captured: AbortSignal) {
    if (captured.aborted) return;
    clearIdentity();
    view.loading = false;
    publish();
  }
  function publishCartAndInvalidateReads(cart: Cart, captured: AbortSignal) {
    captured.throwIfAborted();
    // An acknowledged mutation or conflict response supersedes outstanding reads.
    cartRequest++;
    if (!view.cart || cart.revision >= view.cart.revision) {
      if (
        !view.cart ||
        cart.revision !== view.cart.revision ||
        cart.totalCents !== view.cart.totalCents
      )
        view.quote = null;
      view.cart = cart;
      publish();
    }
  }
  async function request<T>(
    current: Account,
    path: string,
    schema: z.ZodType<T>,
    init?: AccountRequest,
  ): Promise<T> {
    try {
      return await current.json(path, schema, init);
    } catch (cause) {
      if (!(cause instanceof ApiError)) throw cause;
      if (cause.detail.cart) publishCartAndInvalidateReads(cause.detail.cart, current.signal);
      if (path === "checkout/confirm" && [404, 409].includes(cause.status)) {
        view.quote = null;
        publish();
        try {
          await listProducts(init?.signal);
          current.signal.throwIfAborted();
        } catch (refresh) {
          current.signal.throwIfAborted();
          if (refresh instanceof Error && refresh.name === "AbortError") throw refresh;
          refreshWarningRevision++;
          view.refreshWarning = "Products could not refresh. Refresh before shopping again.";
          publish();
        }
      }
      throw cause;
    }
  }
  // Only the newest cart read publishes, and a mutation response supersedes reads still
  // in flight. Callers get the latest acknowledged cart, which may not be their own response.
  async function getCart(signal?: AbortSignal) {
    const current = account();
    const read = ++cartRequest;
    const cart = await request(current, "cart", cartSchema, { signal });
    if (read === cartRequest) publishCartAndInvalidateReads(cart, current.signal);
    return view.cart ?? cart;
  }
  // A catalog read publishes unless a newer read already has, so a newer read that fails
  // cannot hide an older success. Callers get the latest published products.
  async function listProducts(signal?: AbortSignal) {
    const read = ++catalogRequest;
    const catalog = await request(account(), "catalog", catalogSchema, { signal });
    if (read > publishedCatalogRequest) {
      publishedCatalogRequest = read;
      view.products = catalog.products;
      publish();
    }
    return { ...catalog, products: view.products };
  }
  async function refreshAfterChange(captured: AbortSignal, source: "app" | "checkout" = "app") {
    captured.throwIfAborted();
    const refreshed = await Promise.allSettled([getCart(), listProducts()]);
    captured.throwIfAborted();
    for (const result of refreshed) {
      if (
        result.status === "rejected" &&
        result.reason instanceof Error &&
        result.reason.name === "AbortError"
      )
        throw result.reason;
    }
    if (refreshed.some((result) => result.status === "rejected")) {
      refreshWarningRevision++;
      view.refreshWarning =
        source === "checkout"
          ? "Order recorded. Cart or products could not refresh. Refresh before shopping again."
          : "Cart or products could not refresh. Refresh before shopping again.";
      publish();
    }
  }
  async function load() {
    let captured = lifetime.signal;
    view.loading = true;
    publish();
    try {
      const session = await request(account(), "auth/get-session", sessionSchema);
      if (session.user?.id !== view.user?.id) {
        clearIdentity();
        captured = lifetime.signal;
        view.user = session.user;
        logoutUserId = undefined;
        publish();
      }
      // A concurrent app refresh can fail while load is reading. Clear only the
      // warning that this load began with, not a newer failure that still needs review.
      const warningRevision = refreshWarningRevision;
      if (view.user) await Promise.all([getCart(), listProducts()]);
      captured.throwIfAborted();
      if (warningRevision === refreshWarningRevision) view.refreshWarning = "";
      publish();
    } finally {
      if (!captured.aborted) {
        view.loading = false;
        publish();
      }
    }
  }
  async function logout() {
    // Clear local capabilities immediately, but retain the original logout target
    // for retries. Another tab may change the cookie account before the retry arrives.
    logoutUserId = view.user?.id ?? logoutUserId;
    clearIdentity();
    const current = account(logoutUserId);
    try {
      if (logoutUserId) {
        try {
          await request(current, "auth/sign-out", z.object({ success: z.boolean() }), { json: {} });
        } catch (cause) {
          // The session is already gone, which is what sign-out wanted.
          if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
        }
        logoutUserId = undefined;
      }
    } finally {
      if (!current.signal.aborted) {
        view.loading = false;
        publish();
      }
    }
  }
  function queueWrite<T>(work: (current: Account) => Promise<T>, signal?: AbortSignal) {
    const current = account();
    const result = writes
      .catch(() => {})
      .then(async () => {
        current.signal.throwIfAborted();
        signal?.throwIfAborted();
        view.busy = true;
        publish();
        try {
          return await work(current);
        } finally {
          if (!current.signal.aborted) {
            view.busy = false;
            publish();
          }
        }
      });
    writes = result;
    return result;
  }
  function setQuantity(input: unknown, signal?: AbortSignal) {
    const parsed = quantitySchema.parse(input);
    return queueWrite(async (current) => {
      if (!view.cart) await getCart(signal);
      current.signal.throwIfAborted();
      const cart = await request(current, "cart/quantity", cartSchema, {
        json: { ...parsed, expectedRevision: view.cart?.revision },
        signal,
      });
      publishCartAndInvalidateReads(cart, current.signal);
      view.order = null;
      publish();
      return cart;
    }, signal);
  }
  function prepareCheckout() {
    return queueWrite(async (current) => {
      view.quote = null;
      view.order = null;
      publish();
      const quote = await request(current, "checkout/quote", quoteSchema, { json: {} });
      view.quote = quote;
      publish();
      return quote;
    });
  }
  function confirmCheckout(quoteId: string) {
    return queueWrite(async (current) => {
      const order = await request(current, "checkout/confirm", orderSchema, {
        json: { quoteId },
      });
      view.quote = null;
      view.order = order;
      publish();
      await refreshAfterChange(current.signal, "checkout");
      return order;
    });
  }
  // Each tool set captures the lifetime it was created in, so retained callbacks
  // cannot start work for a later account, even if a caller forgets to unregister them.
  function tools() {
    const captured = lifetime.signal;
    return shopTools.map((tool) => ({
      ...tool,
      async execute(input: unknown, { signal }: { signal: AbortSignal }) {
        captured.throwIfAborted();
        signal.throwIfAborted();
        let result;
        const name = tool.name;
        switch (name) {
          case "list_products":
            emptySchema.parse(input);
            result = await listProducts(signal);
            break;
          case "get_cart":
            emptySchema.parse(input);
            result = await getCart(signal);
            break;
          case "set_cart_quantity":
            result = await setQuantity(input, signal);
            break;
          default: {
            const _exhaustive: never = name;
            throw new Error(`Unknown shopping tool: ${_exhaustive}`);
          }
        }
        return JSON.stringify(result);
      },
    }));
  }
  return {
    load,
    logout,
    refreshAfterChange,
    setQuantity,
    prepareCheckout,
    confirmCheckout,
    get tools() {
      return tools();
    },
    account: () => account(),
    dispose: () => lifetime.abort(closed()),
  };
}
export type Shop = ReturnType<typeof createShop>;
