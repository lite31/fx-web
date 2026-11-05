# MCP Apps and external hosts

Interactive cards call MCP tools without another model turn. External MCP
hosts access the same shop through OAuth and explicit consent.

## Sub-features

- `apps-card` opens a product card and changes the shared cart with Add to cart.
- `apps-catalog` filters products and edits absolute cart quantities while displaying confirmed values and totals.
- `apps-isolation` blocks parent/sibling access and unapproved network requests.
- `apps-refresh` recovers failed cart or catalog refreshes without repeating an app mutation.
- `apps-cleanup` removes frames and ignores pending calls after reset, logout, or SPA disposal. Restored app entries stay inert.
- `mcp-oauth` signs in and consents before granting an external host access.
- `mcp-session` enforces scopes, revisions and the authorizing session's lifetime.

## How to get to it (user POV)

In `fx` chat, ask for coffee to display a product card, then choose Add to cart.
An explicit request to add coffee may mutate the cart and display its card.
External hosts connect to the application's `/mcp` URL and open `/oauth/sign-in`
and `/oauth/consent`. Checkout remains in the shop's human confirmation UI.

## Driving it with Task and agent-browser

Preconditions: a card needs a Gateway key, a JSPI-capable browser, and
`task mcp-sandbox -- --host-origin "$(task -t "$FX_VERIFY_TASK" origin)"`
listening on port 5174. The baseline run has no key, so chat stops at the
configuration alert before it opens an MCP conversation. The page makes no
`/api/mcp/conversations` request, and no card can render even with the sandbox
running. Report `apps-card`, `apps-catalog`, `apps-isolation`, `apps-refresh`,
and `apps-cleanup` as verified-unreachable in the baseline run, and use the
existing real-SDK browser fixtures for them:

```bash
task test-browser > "${FX_VERIFY_RUN}.evidence/browser-tests.log" 2>&1
```

Reuse this log if the chat journey already ran the suite. It prints six MCP
Apps PASS lines:

- The account form.
- The App and AppBridge handshake, sibling and parent isolation, CSP, app cart
  tools including catalog quantities, latest context, busy acknowledgement, and
  reset fencing.
- Second-server chart filtering.
- Focused coffee cards, direct Add, failed cart and catalog refresh recovery
  without replay, shared cart, conflicts, and the stock guard.
- Inert restored entries.
- Account change and SPA disposal.

The OAuth sign-in and consent check is a subtest that prints no PASS line.
Look for `✔ OAuth browser sign-in returns to explicit consent before issuing a
session-bound token` in the same log. The fixture supplies model decisions and
isolated servers. It also injects probe scripts and fetch failures into views.
It retains the production MCP transports, provider, auth, and UI.

For the catalog, the suite checks that accepted edits update quantities and
totals, that empty, fractional, and over-stock edits keep the last confirmed
quantity, and that a later valid edit still works. It also checks filtering to
one product and clearing the filter. Review order in shop is a button inside the
card. The host then shows an Open shop checkout link that opens `/` in a new
tab, where the shop's Review order panel confirms the order. No test clicks it,
so inspect it in a live card.

For `apps-refresh`, the suite checks a committed Add followed by a failed cart
read, and a rejected stale Add followed by a failed catalog read. The shared
shop shows a warning and disables stale cart controls, and checkout too after
the failed cart read. Refresh cart restores the current quantity, clears the
warning, and leaves the app write count unchanged.

The provider is reachable in the baseline run. With `O` set to the run's origin,
check these without a token:

```bash
curl -si -X POST "$O/mcp" -H 'content-type: application/json' -d '{}'
curl -s "$O/.well-known/oauth-protected-resource/mcp"
curl -si "$O/mcp" -H 'Origin: http://evil.test'
task -t "$FX_VERIFY_TASK" browser -- open "$O/oauth/consent?scope=shop:read%20shop:write"
```

Expect HTTP 401 with `WWW-Authenticate: Bearer resource_metadata=...` and
`scope="shop:read shop:write"`, metadata whose `resource` is `$O/mcp`, HTTP 403
with "Use the configured local MCP endpoint.", and a consent page with the
heading Authorize Connected MCP host and the buttons Allow access and Deny.

Run `task test` for the provider's real HTTP/PKCE/token, scope, and
revocation contracts. It does not prove that a
named external product renders an inline card. Test that separately against an
explicitly chosen host and this run's `/mcp` URL, without reconfiguring the
user's existing connection to the development app.

## Gotchas

An iframe's price text does not prove an Add mutation. Check shared cart state
and absence of another model turn. A second port on the same hostname does not
isolate cookies; the production sandbox uses the opposite loopback hostname.
Do not inject the browser suite's probe scripts during a manual proof. Native
Codex/ChatGPT rendering and live natural-language selection remain separate checks.
