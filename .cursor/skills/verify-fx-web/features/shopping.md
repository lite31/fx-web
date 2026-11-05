# Shopping and checkout

Product buttons and cart controls change the same server-owned cart. Reviewing
an order shows a quote; confirming it records the order and deducts stock.

## Sub-features

- `cart-add` adds a product through its shop card.
- `cart-edit` changes quantities or removes an item inside Cart.
- `cart-persist` restores the same cart after reload and sign-in.
- `cart-limit` disables Add and Increase at the available stock or quantity 99.
- `checkout-review` obtains a quote without recording an order or changing stock.
- `checkout-invalidate` removes the displayed quote when the cart changes.
- `checkout-confirm` records one order, clears the cart, and deducts stock.
- `checkout-refresh` preserves a recorded receipt when the following refresh fails and offers Refresh cart.

## How to get to it (user POV)

Sign in at `/`. Use the three product cards or open Cart in the header. Inside
Cart, choose Review order, inspect the quote, then choose Confirm order for €5.00
for a one-coffee cart. MCP Apps link back to this first-party checkout.

## Driving it with Task and agent-browser

Preconditions: `fx_verify` is signed in, all three products appear, its cart is
empty, and coffee costs €5 with ten units available.

```bash
task -t "$FX_VERIFY_TASK" browser -- snapshot -i > "${FX_VERIFY_RUN}.evidence/cart-before.txt"
task -t "$FX_VERIFY_TASK" state > "${FX_VERIFY_RUN}.evidence/state-before.json"
task -t "$FX_VERIFY_TASK" browser -- find role button click --name "Add Coffee to cart"
task -t "$FX_VERIFY_TASK" browser -- wait --text 'Cart: 1 items, total €5.00.'
task -t "$FX_VERIFY_TASK" browser -- find role button click --name 'Cart, 1 items'
task -t "$FX_VERIFY_TASK" browser -- snapshot -i
```

- `cart-add` passes when Cart shows Coffee, quantity 1, total €5.00, and `state` shows a coffee row for `fx_verify` with quantity 1. Stock stays 10 and orders stay empty.
- `cart-edit` uses buttons labeled Increase Coffee quantity, Decrease Coffee quantity, and Remove Coffee. Verify the total after each action. Close Cart before using a product's Add button, then reopen Cart for its controls. Add one coffee again before checkout.
- `cart-persist` reloads with `task -t "$FX_VERIFY_TASK" browser -- reload`, waits for `Cart: 1 items, total €5.00.`, then reopens Cart. Complete the [account isolation journey](accounts.md) to check restoration after sign-in too. Return to `fx_verify` with one coffee before checkout. Save another screenshot and state read.
- `checkout-review` clicks `Review order`. The Review order section must show a €5.00 quote with an expiry time. Compare `state` with the pre-review read: no order or stock change.
- `checkout-invalidate` increases Coffee to two after review. The quote must disappear. Decrease to one and review again before confirming.
- `checkout-confirm` clicks the button named `Confirm order for €5.00` only in this disposable run and only when the requested verification includes checkout. The receipt must appear, the cart must clear, coffee stock must become 9, and `state` must show exactly one order. Reload and confirm the empty cart remains. The server's idempotency and rollback contracts are also covered by `task test`.
- `cart-limit` closes Cart and adds Coffee until the cart reaches the remaining stock, then reopens Cart. After the first checkout, Add Coffee to cart and Increase Coffee quantity must both disable at nine. Remove Coffee afterward.

To check `checkout-refresh`, close Cart, add one coffee, reopen Cart, and review a new quote. Record the
current orders and stock. Block the cart read before confirming:

```bash
task -t "$FX_VERIFY_TASK" browser -- network route '**/api/cart' --abort
task -t "$FX_VERIFY_TASK" browser -- find role button click --name 'Confirm order for €5.00' --exact
task -t "$FX_VERIFY_TASK" browser -- wait --text 'Order recorded. Cart or products could not refresh'
task -t "$FX_VERIFY_TASK" state > "${FX_VERIFY_RUN}.evidence/recorded-before-refresh.json"
task -t "$FX_VERIFY_TASK" browser -- network unroute '**/api/cart'
task -t "$FX_VERIFY_TASK" browser -- find role button click --name 'Refresh cart' --exact
```

Before recovery, the receipt must remain visible and shopping controls must be
disabled. The page still shows the old cart, such as "Cart, 1 items", because
the cart read failed. The database must show one additional order, one less
coffee in stock, and an empty cart. After refresh, the warning must clear, the
UI must show the empty cart, and the receipt stays visible. Another `state`
read must match the recorded state without another
order or stock decrement. Always remove the route after this check, even on
failure. Run doctor and reset the page before continuing after a failed drive.

Capture `cart-after.txt`, `after.png`, and `state.json` with the parent skill's
evidence commands. Record each clicked button in `actions.txt`.

## Gotchas

Quantities are absolute on the backend. Use a fresh run rather than reseeding
an active database. Do not confirm checkout merely to prove Add works. An
order receipt alone is insufficient; check persisted order IDs, stock, and cart.
A quote expires five minutes after Review order. If Confirm reports "Review
expired or cart changed. Review your order again.", review again.
