# fx-web verification map

Read the matching feature before driving the app. These are separate entry
points; passing one does not prove the others.

## Baseline

Use the parent skill's new run, seeded catalog, unique origin and browser
session. Run doctor first. Create the disposable `fx_verify` account through
the UI with `fx_verify@example.com` and password `fx-verify-password-2026`.
Those credentials are for this temporary instance only. A fresh account's cart
is empty. The baseline disables model inference and unconfigured remote MCP
servers. Never substitute the user's app at port 5173 or its database.

## Features

| Feature | Entry points | Proof |
| --- | --- | --- |
| [Account access](accounts.md) | `/`, `/sign-in`, header sign-out | Redirects, session persistence, logout recovery, separate accounts |
| [Shopping and checkout](shopping.md) | Product Add buttons, Cart, Review order, Confirm order, Refresh cart | Persisted quantities, stock limits, quote invalidation, recorded-order recovery |
| [Chat lifecycle](chat.md) | Message composer, Enter/Send, Stop reply, New conversation, recovery buttons | Replies, saved history, interrupted turns, reset/cancellation, account cleanup |
| [WebMCP actions](webmcp.md) | Browser tool registry | Same cart through UI and published callbacks |
| [MCP Apps and host access](mcp-apps.md) | Product and catalog cards in `fx` chat, `/mcp`, OAuth consent | Direct app cart edits, confirmed quantities, iframe isolation, delegated-session checks |

Record actions and outcomes under `${FX_VERIFY_RUN}.evidence`. Screenshots
alone do not prove a mutation. Pair them with a reload and `state` output.
The existing browser suites create and clean their own instances. Retain their
stdout as evidence, but do not claim every map entry passed when only those
suites ran. Live-model behavior and named external hosts need separate runs.
