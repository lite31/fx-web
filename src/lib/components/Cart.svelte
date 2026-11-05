<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { formatPrice } from "$lib/contract";
  import type { ShopView } from "$lib/shop";
  let {
    view,
    setQuantity,
    review,
    confirm,
    refresh,
    error,
  }: {
    view: ShopView;
    setQuantity: (input: { product_id: string; quantity: number }) => Promise<void>;
    review: () => Promise<void>;
    confirm: (id: string) => Promise<void>;
    refresh: () => Promise<void>;
    error: string;
  } = $props();
</script>

<Button
  type="button"
  variant="outline"
  popovertarget="cart-panel"
  aria-label={view.cart ? `Cart, ${view.cart.count} items` : "Cart loading"}
  ><span aria-hidden="true">🛒</span> Cart {view.cart ? `(${view.cart.count})` : "…"}</Button
>
<div
  id="cart-panel"
  popover
  role="dialog"
  class="fixed inset-0 m-auto max-h-dvh w-96 max-w-full overflow-y-auto rounded-xl border bg-background p-4 text-foreground shadow-xl"
  aria-labelledby="cart-heading"
>
  <div class="flex items-center justify-between gap-4">
    <h2 id="cart-heading" class="text-base font-semibold">Your cart</h2>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      popovertarget="cart-panel"
      popovertargetaction="hide">Close</Button
    >
  </div>
  {#if error}<p class="mt-3 text-sm text-destructive">{error}</p>{/if}
  {#if view.refreshWarning}
    <p class="mt-3 text-sm" role="status">{view.refreshWarning}</p>
    <Button type="button" variant="outline" disabled={view.busy || view.loading} onclick={refresh}
      >Refresh cart</Button
    >
  {/if}
  {#if view.loading || !view.cart}<p class="py-6 text-sm" role="status">Loading cart…</p>
  {:else}
    {#if !view.cart.items.length}<p class="py-6 text-sm text-muted-foreground">
        Your cart is empty.
      </p>{/if}
    <ul class="my-4 space-y-4">
      {#each view.cart.items as item (item.id)}<li class="space-y-2">
          <div class="flex items-center justify-between text-sm">
            <span><span aria-hidden="true">{item.emoji}</span> {item.name}</span><span
              >{formatPrice(item.lineTotalCents)}</span
            >
          </div>
          <div class="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Decrease ${item.name} quantity`}
              disabled={view.busy || !!view.refreshWarning}
              onclick={() => setQuantity({ product_id: item.id, quantity: item.quantity - 1 })}
              >−</Button
            ><span class="min-w-6 text-center text-sm">{item.quantity}</span><Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Increase ${item.name} quantity`}
              disabled={view.busy ||
                !!view.refreshWarning ||
                !item.active ||
                item.quantity >= Math.min(99, item.stock)}
              onclick={() => setQuantity({ product_id: item.id, quantity: item.quantity + 1 })}
              >+</Button
            ><Button
              type="button"
              variant="ghost"
              size="sm"
              class="ml-auto"
              aria-label={`Remove ${item.name}`}
              disabled={view.busy || !!view.refreshWarning}
              onclick={() => setQuantity({ product_id: item.id, quantity: 0 })}>Remove</Button
            >
          </div>
        </li>{/each}
    </ul>
    <p class="flex justify-between border-t pt-3 text-sm font-medium">
      <span>Total</span><span>{formatPrice(view.cart.totalCents)}</span>
    </p>
    <p class="my-2 text-xs text-muted-foreground">
      Cart prices may change. Orders record these items only. No payment, shipping or tax is
      collected.
    </p>
    <Button
      type="button"
      variant="outline"
      disabled={view.busy || !!view.refreshWarning || !view.cart.count}
      onclick={review}>Review order</Button
    >
  {/if}
  {#if view.quote}
    <section aria-label="Review order" class="mt-4 space-y-3 border-t pt-3">
      <h3 class="font-medium">Review your order</h3>
      <ul class="space-y-2 text-sm">
        {#each view.quote.items as item (item.id)}<li>
            {item.quantity} × {item.name} · {formatPrice(item.lineTotalCents)}
          </li>{/each}
      </ul>
      <p class="text-sm">
        Total {formatPrice(view.quote.totalCents)}. Review expires at {new Date(
          view.quote.expiresAt,
        ).toLocaleTimeString()}.
      </p>
      <p class="text-xs text-muted-foreground">
        Confirm records an order. No payment is collected.
      </p>
      <Button
        type="button"
        disabled={view.busy || !!view.refreshWarning}
        onclick={() => view.quote && confirm(view.quote.id)}
        >Confirm order for {formatPrice(view.quote.totalCents)}</Button
      >
    </section>
  {/if}
  {#if view.order}<p class="mt-4 text-sm" role="status">
      Order {view.order.id} recorded for {formatPrice(view.order.totalCents)}. No payment collected.
    </p>{/if}
</div>
