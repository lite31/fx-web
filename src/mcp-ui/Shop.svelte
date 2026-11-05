<script lang="ts">
  import { onMount } from "svelte";
  import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
  import { z } from "zod";
  import { CallToolResultSchema } from "@modelcontextprotocol/core";
  import {
    cartSchema,
    catalogSchema,
    mutationSchema,
    productQuerySchema,
    formatPrice,
    matchesQuery,
    type Cart,
    type Product,
  } from "../lib/contract";

  const payloadSchema = z.object({
    catalog: catalogSchema.optional(),
    cart: cartSchema.optional(),
    error: z.string().optional(),
  });
  type CallToolResult = z.infer<typeof CallToolResultSchema>;
  type ShopCall =
    | { name: "list_products"; arguments: z.input<typeof productQuerySchema> }
    | { name: "set_cart_quantity"; arguments: z.input<typeof mutationSchema> };
  const metadataSchema = z.object({ shopUrl: z.url().optional() });
  const app = new App({ name: "fx shop", version: "1.0.0" }, {});
  let products = $state<Product[]>([]);
  let cart = $state<Cart>();
  type Focus =
    | { kind: "catalog" }
    | { kind: "query"; query: string }
    | { kind: "product"; productId: string };
  let focus = $state<Focus>({ kind: "catalog" });
  let catalogLoaded = false;
  let initialResult = false;
  let filter = $state("");
  let ready = $state(false);
  let busy = $state(false);
  let error = $state("");
  let shopUrl = $state("");
  let disposed = false;
  const visible = $derived(
    products.filter((product) => {
      switch (focus.kind) {
        case "product":
          return product.id === focus.productId;
        case "query":
          return matchesQuery(product, focus.query);
        case "catalog":
          return product.name.toLowerCase().includes(filter.toLowerCase());
        default: {
          const _exhaustive: never = focus;
          throw new Error(`Unknown shop focus: ${_exhaustive}`);
        }
      }
    }),
  );

  function adopt(result: CallToolResult) {
    const payload = payloadSchema.safeParse(result.structuredContent);
    if (payload.success) {
      if (payload.data.catalog) {
        products = payload.data.catalog.products;
        catalogLoaded = true;
      }
      if (payload.data.cart && (!cart || payload.data.cart.revision >= cart.revision))
        cart = payload.data.cart;
      if (payload.data.error) error = payload.data.error;
    }
    const metadata = metadataSchema.safeParse(result._meta);
    if (metadata.success && metadata.data.shopUrl) {
      const url = new URL(metadata.data.shopUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
        shopUrl = url.href;
    }
    if (result.isError && !error)
      error =
        result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n") || "The shop request failed.";
  }
  async function call(request: ShopCall) {
    const result = await app.callServerTool(request);
    if (!disposed) adopt(result);
    return result;
  }
  async function refresh() {
    if (!ready || busy) return;
    busy = true;
    error = "";
    try {
      await call({
        name: "list_products",
        arguments: focus.kind === "query" ? { query: focus.query } : {},
      });
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : "Unable to refresh the shop.";
    } finally {
      if (!disposed) busy = false;
    }
  }
  // Connection readiness and the initial tool result may arrive in either order.
  // Wait for both before fetching a catalog absent from that result.
  async function loadMissing() {
    if (!ready || !initialResult || catalogLoaded || busy || error) return;
    await refresh();
  }
  // Send the revision this card last saw. Adopt any current cart returned with
  // a conflict, but leave the user to decide whether to retry the mutation.
  async function quantity(product_id: string, value: number) {
    if (!cart || !ready || busy || !Number.isInteger(value)) return;
    busy = true;
    error = "";
    try {
      await call({
        name: "set_cart_quantity",
        arguments: { product_id, quantity: value, expectedRevision: cart.revision },
      });
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : "Unable to update the cart.";
    } finally {
      if (!disposed) busy = false;
    }
  }
  async function updateContext() {
    if (!ready) return;
    try {
      await app.updateModelContext({
        content: [
          {
            type: "text",
            text: JSON.stringify({ focus, filter, revision: cart?.revision, count: cart?.count }),
          },
        ],
      });
    } catch (cause) {
      if (!disposed)
        error = cause instanceof Error ? cause.message : "Unable to update app context.";
    }
  }
  async function checkout() {
    if (!shopUrl || !ready) return;
    try {
      const result = await app.openLink({ url: shopUrl });
      if (result.isError) error = "Open the first-party shop to review and confirm your order.";
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : "Unable to open the shop.";
    }
  }
  onMount(() => {
    app.ontoolinput = ({ arguments: args }) => {
      const mutation = mutationSchema.safeParse(args);
      const listing = productQuerySchema.safeParse(args);
      if (mutation.success) focus = { kind: "product", productId: mutation.data.product_id };
      else if (listing.success && listing.data.query)
        focus = { kind: "query", query: listing.data.query };
    };
    app.ontoolresult = (result) => {
      if (disposed) return;
      adopt(result);
      initialResult = true;
      void loadMissing();
    };
    app.ontoolcancelled = () => {
      if (!disposed) error = "The tool call was cancelled.";
    };
    void app
      .connect(new PostMessageTransport(window.parent, window.parent))
      .then(() => {
        if (!disposed) {
          ready = true;
          void loadMissing();
        }
      })
      .catch((cause: unknown) => {
        if (!disposed)
          error = cause instanceof Error ? cause.message : "Unable to connect to the host.";
      });
    return () => {
      disposed = true;
      void app.close();
    };
  });
</script>

<main class:compact={focus.kind !== "catalog"}>
  {#if focus.kind === "catalog"}
    <header>
      <div>
        <h1>Shop</h1>
        <p>Browse products and edit your cart.</p>
      </div>
      <button onclick={refresh} disabled={!ready || busy}>Refresh</button>
    </header>
    <label for="product-filter">Filter products</label>
    <input
      id="product-filter"
      type="search"
      placeholder="Find a product"
      value={filter}
      oninput={(event) => {
        filter = event.currentTarget.value;
        void updateContext();
      }}
    />
  {:else}
    <button
      class="refresh"
      aria-label="Refresh products"
      onclick={refresh}
      disabled={!ready || busy}>Refresh</button
    >
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !ready}<p role="status">Connecting to the shop…</p>{/if}
  <div class="products">
    {#each visible as product (product.id)}
      {@const count = cart?.items.find((item) => item.id === product.id)?.quantity ?? 0}
      <article>
        <span class="emoji" aria-hidden="true">{product.emoji}</span>
        <div class="details">
          <strong>{product.name}</strong><span
            >{formatPrice(product.priceCents)}{product.stock === 0 ? " · Out of stock" : ""}</span
          >
        </div>
        {#if focus.kind !== "catalog"}
          <div class="add">
            <button
              disabled={!ready || busy || !cart || count >= Math.min(99, product.stock)}
              onclick={() => quantity(product.id, count + 1)}>Add to cart</button
            >
            {#if count}<small>{count} in cart</small>{/if}
          </div>
        {:else}
          <label class="quantity"
            >Quantity<input
              aria-label={`Quantity for ${product.name}`}
              type="number"
              min="0"
              max={Math.min(99, product.stock)}
              value={count}
              disabled={!ready || busy || !cart}
              onchange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                event.currentTarget.value = String(count);
                void quantity(product.id, value);
              }}
            /></label
          >
        {/if}
      </article>
    {/each}
    {#if ready && !visible.length}<p>No matching products.</p>{/if}
  </div>
  {#if focus.kind === "catalog"}
    <footer>
      <p>
        <strong>{cart?.count ?? 0} items</strong><span
          >Total {formatPrice(cart?.totalCents ?? 0)}</span
        >
      </p>
      <button onclick={checkout} disabled={!ready || !shopUrl || !cart?.count}
        >Review order in shop</button
      ><small>Review and confirm your order in the first-party shop.</small>
    </footer>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    font:
      14px system-ui,
      sans-serif;
    color: #18212c;
    background: #fff;
  }
  main {
    padding: 18px;
  }
  .compact {
    padding: 12px;
  }
  .compact article {
    border: 0;
    padding: 8px 0;
  }
  .refresh {
    display: block;
    margin-left: auto;
    padding: 4px 8px;
    font-size: 12px;
  }
  .add {
    text-align: center;
  }
  .add small {
    margin-top: 4px;
  }
  header,
  article {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  header {
    justify-content: space-between;
    margin-bottom: 20px;
  }
  h1 {
    margin: 0;
    font-size: 22px;
  }
  p {
    margin: 6px 0;
  }
  header p,
  .details span,
  small {
    color: #5b6571;
  }
  label {
    display: block;
    font-weight: 600;
    margin-bottom: 5px;
  }
  input,
  button {
    font: inherit;
    padding: 9px 12px;
    border: 1px solid #ccd2d9;
    border-radius: 8px;
  }
  input[type="search"] {
    width: 100%;
  }
  button {
    cursor: pointer;
    background: #17212e;
    color: #fff;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  article {
    border-bottom: 1px solid #e8ebef;
    padding: 16px 0;
  }
  .emoji {
    font-size: 28px;
  }
  .details {
    display: grid;
    gap: 4px;
    flex: 1;
  }
  .quantity {
    font-size: 11px;
    margin: 0;
  }
  .quantity input {
    display: block;
    width: 72px;
    margin-top: 4px;
  }
  .error {
    padding: 10px;
    color: #9f1e1e;
    background: #fff1f1;
    border-radius: 8px;
  }
  footer {
    margin-top: 18px;
  }
  footer p {
    display: flex;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  footer button {
    width: 100%;
  }
  small {
    display: block;
    margin-top: 9px;
  }
</style>
