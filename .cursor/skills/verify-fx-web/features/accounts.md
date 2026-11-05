# Account access

Visitors create an account or sign in before they can shop. Sessions survive a
reload; signing out revokes the session and returns to the sign-in page.

## Sub-features

- `account-redirect` sends signed-out visitors to `/sign-in` and signed-in visitors back to `/`.
- `account-create` creates an account from the form and opens the shop.
- `account-persist` retains the account on reload.
- `account-isolation` keeps two users' carts separate.
- `account-logout` revokes access through the header's Sign out button.
- `account-retry` clears private UI state immediately and offers Retry sign out if the request fails.

## How to get to it (user POV)

Visit `/` or `/sign-in`. Choose Create an account or Use existing account.
Signed-in users can choose the header icon labeled Sign out.

## Driving it with Task and agent-browser

Preconditions: a fresh prepared run is listening and doctor passes.

- Open the allocated origin with `task -t "$FX_VERIFY_TASK" browser -- open "$(task -t "$FX_VERIFY_TASK" origin)"`. The URL ends in `/sign-in`.
- Choose account creation with `task -t "$FX_VERIFY_TASK" browser -- find role button click --name "Create an account"`.
- Fill the actual form fields:

```bash
task -t "$FX_VERIFY_TASK" browser -- fill 'input[autocomplete="username"]' fx_verify
task -t "$FX_VERIFY_TASK" browser -- fill 'input[type="email"]' fx_verify@example.com
task -t "$FX_VERIFY_TASK" browser -- fill 'input[type="password"]' fx-verify-password-2026
task -t "$FX_VERIFY_TASK" browser -- find role button click --name "Create account"
task -t "$FX_VERIFY_TASK" browser -- wait --url 'http://127.0.0.1:*/'
task -t "$FX_VERIFY_TASK" browser -- wait --text Coffee
task -t "$FX_VERIFY_TASK" browser -- snapshot -i
```

- Confirm the header says `fx_verify` and all three products appear. Reload with `task -t "$FX_VERIFY_TASK" browser -- reload` and check the same account.
- Visit `/sign-in` while signed in. The app must return to `/` with the same cart.
- For logout, run `task -t "$FX_VERIFY_TASK" browser -- find role button click --name "Sign out"`. Wait for `/sign-in`; visiting `/` must redirect there again.
- For sign-in, submit a wrong password first. Check the error and cleared password field. Then sign in with ` FX_VERIFY ` and the correct password. Username normalization must restore the existing account and cart.
- For isolation, first add a coffee using the shopping journey, sign out, then create `fx_other` with email `fx_other@example.com` and the same disposable password. Its cart must be empty. Signing back into `fx_verify` must restore its coffee.

To check logout recovery, block only the run's sign-out request:

```bash
task -t "$FX_VERIFY_TASK" browser -- network route '**/api/auth/sign-out' --abort
task -t "$FX_VERIFY_TASK" browser -- find role button click --name 'Sign out' --exact
task -t "$FX_VERIFY_TASK" browser -- wait '[aria-label="Retry sign out"]'
task -t "$FX_VERIFY_TASK" browser -- network unroute '**/api/auth/sign-out'
task -t "$FX_VERIFY_TASK" browser -- find role button click --name 'Retry sign out' --exact
```

Before retrying, check the error and hidden account name, products, and cart.
The conversation must be empty and its composer disabled. Its container remains
visible. After retrying, check that the page returns to `/sign-in`.
Always remove the route, including after a failed check. Run doctor after a
failed drive and reopen a known page before continuing.

## Gotchas

Use only the disposable credentials above. Do not save auth cookies or session
responses in evidence. The chat's missing-Gateway error does not mean account
creation failed. Wait for catalog loading before judging the empty state.
