<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import Cart from "$lib/components/Cart.svelte";
  import Chat from "$lib/components/Chat.svelte";
  import * as Card from "$lib/components/ui/card";
  import { formatPrice } from "$lib/contract";
  import { createShop, createShopView } from "$lib/shop";
  import { registerWebMcpTools } from "$lib/webmcp";

  let view = $state.raw(createShopView());
  let mounted = false;
  let accountLoaded = false;
  let loggingOut = $state(false);
  let logoutFailed = $state(false);
  let unregisterTools: (() => void) | undefined;
  // On an account change, replace the WebMCP tools with tools bound to the new account.
  // Losing a loaded account sends the page to sign-in, except while signing out or after a failed sign-out.
  const shop = createShop((updated) => {
    const changed = updated.user?.id !== view.user?.id;
    view = updated;
    if (view.user) accountLoaded = true;
    if (changed && mounted) {
      ready = false;
      unregisterTools?.();
      webmcpError = "";
      if (view.user) {
        const captured = shop.account().signal;
        unregisterTools = registerWebMcpTools(shop.tools, (message) => {
          if (!captured.aborted) webmcpError = message;
        });
      }
    }
    if (mounted && accountLoaded && !view.user && !view.loading && !loggingOut && !logoutFailed)
      window.location.assign("/sign-in");
  });
  let shopError = $state("");
  async function action(work: () => Promise<unknown>) {
    shopError = "";
    try {
      await work();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        shopError = cause instanceof Error ? cause.message : "Request failed.";
    }
  }
  async function signOut() {
    if (loggingOut) return;
    loggingOut = true;
    logoutFailed = false;
    shopError = "";
    try {
      await shop.logout();
      window.location.assign("/sign-in");
    } catch (cause) {
      logoutFailed = true;
      shopError = cause instanceof Error ? cause.message : "Sign out failed. Try again.";
    } finally {
      loggingOut = false;
    }
  }
  let webmcpError = $state("");

  let disposed = false;
  let model = $state("");
  let ready = $state(false);

  onMount(() => {
    mounted = true;
    void action(async () => {
      await shop.load();
      if (!disposed && !view.user) window.location.assign("/sign-in");
      accountLoaded = true;
    });
    return () => {
      unregisterTools?.();
      disposed = true;
      shop.dispose();
    };
  });
</script>

<svelte:head>
  <title>fx-web · The agentic web</title>
  <meta name="description" content="AI that works alongside you, inside your app." />
</svelte:head>

<main class="mx-auto flex h-dvh min-h-165 max-w-3xl flex-col gap-4 px-4 py-4 sm:px-6">
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">fx-web</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        AI that works alongside you, inside your app.
      </p>
      {#if model}
        <p
          class="mt-2 flex items-center gap-2 font-mono text-xs text-muted-foreground"
          role="status"
        >
          {model}
          {#if ready}<span
              role="img"
              aria-label="Agent ready"
              title="Agent ready"
              class="text-foreground">✓</span
            >{/if}
        </p>
      {/if}
    </div>
    {#if view.user || loggingOut || logoutFailed}
      <div class="flex max-w-full min-w-0 items-center justify-end gap-2 text-sm">
        <span class="flex min-w-0 items-center gap-1.5">
          <svg
            class="size-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            ><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg
          >
          <span class="max-w-32 truncate" title={view.user?.username}
            >{view.user ? view.user.username : "Signing out"}</span
          >
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={logoutFailed ? "Retry sign out" : "Sign out"}
          title={logoutFailed ? "Retry sign out" : "Sign out"}
          disabled={loggingOut}
          onclick={signOut}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path
              d="m16 17 5-5-5-5M21 12H9"
            /></svg
          >
        </Button>
        {#if view.user}<Cart
            {view}
            setQuantity={(input) => action(() => shop.setQuantity(input))}
            review={() => action(() => shop.prepareCheckout())}
            confirm={(id) => action(() => shop.confirmCheckout(id))}
            refresh={() => action(() => shop.load())}
            error={shopError}
          />{/if}
      </div>
    {/if}
  </header>
  {#if view.loading}<p role="status">Loading account and cart…</p>{/if}
  {#if view.user}
    <section class="grid shrink-0 grid-cols-3 gap-2 sm:gap-3" aria-label="Shop products">
      {#each view.products as product (product.id)}
        {@const quantity = view.cart?.items.find((item) => item.id === product.id)?.quantity ?? 0}
        <Card.Root size="sm" class="gap-3"
          ><Card.Header class="px-3"
            ><span class="text-3xl" aria-hidden="true">{product.emoji}</span><Card.Title
              class="text-sm">{product.name}</Card.Title
            ><Card.Description>{formatPrice(product.priceCents)}</Card.Description></Card.Header
          ><Card.Footer class="px-3"
            ><Button
              type="button"
              variant="outline"
              size="sm"
              class="w-full"
              aria-label={`Add ${product.name} to cart`}
              disabled={view.loading ||
                view.busy ||
                !!view.refreshWarning ||
                !view.cart ||
                quantity >= Math.min(99, product.stock)}
              onclick={() =>
                action(() => shop.setQuantity({ product_id: product.id, quantity: quantity + 1 }))}
              >Add</Button
            ></Card.Footer
          ></Card.Root
        >
      {/each}
    </section>
    {#if !view.loading && !view.products.length}<p class="text-sm text-muted-foreground">
        No products are available yet.
      </p>{/if}
    {#if view.cart}<p class="sr-only" role="status">
        Cart: {view.cart.count} items, total {formatPrice(view.cart.totalCents)}.
      </p>{/if}
  {/if}
  {#if shopError}<p role="alert" class="text-sm text-destructive">{shopError}</p>{/if}
  <!-- Account changes unmount Chat and retire its engine, recovery state, and MCP views. -->
  {#key view.user?.id}
    <Chat {shop} {webmcpError} bind:model bind:ready />
  {/key}
</main>
