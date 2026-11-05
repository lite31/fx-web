# WebMCP

The signed-in shop page publishes three tools on `document.modelContext` so
that other browser agents can use the live cart. The tools call the same
controller as the UI and `fx`, as described in
[Architecture](architecture.md#every-browser-actor-shares-one-controller).
`fx` itself does not discover tools through WebMCP. It gets `shop.tools`
directly.

To try the tools, follow the [demonstration guide](demonstrate.md#discover-and-invoke-the-pages-tools).

## The tools

| Tool | Input | Result |
| --- | --- | --- |
| `list_products` | `{ offset? }` | A page of products with IDs, stock, and prices in EUR cents |
| `get_cart` | `{ offset? }` | A page of cart items with the revision and totals for the whole cart |
| `set_cart_quantity` | `{ product_id, quantity }` | A receipt with the new quantity, the revision, and the totals |

These schemas belong to the WebMCP adapter in `src/lib/webmcp.ts`. The direct
`fx` tools in `src/lib/shop.ts` keep their own schemas and return complete
results.

`set_cart_quantity` sets an absolute quantity. Sending
`{ product_id: "coffee", quantity: 2 }` twice leaves two coffees, not four. To
add one, read the cart and send the current quantity plus one. Zero removes
the item, even if the product is no longer available. The backend rejects
quantities outside 0 to 99, extra fields, and client-supplied prices. A
positive quantity needs an active product with enough stock.

The controller queues writes and sends each one with `expectedRevision`. A
revision conflict returns HTTP 409 with the current cart.

## Why the adapter differs from the `fx` tools

Each choice below answers a failure seen during development.

**Results are paged.** A full catalog or cart could exceed an agent's tool
output budget. Each result holds whole rows and at most 1,500 serialized
characters. A page has `offset`, `page_size`, `total_count`, and
`next_offset`. Follow a non-null `next_offset` to continue. Cart pages repeat
the totals for the whole cart. If the revision changes between pages, start
the read again. A product name whose JSON is longer than 600 characters is
shortened and marked `nameTruncated: true`. IDs are never shortened.

**Errors resolve instead of reject.** A rejected native callback reaches the
agent as a generic browser error. The adapter resolves expected failures as
`{ code, error, retryable }` with the code `INVALID_INPUT`, `REQUEST_FAILED`,
or `CANCELLED`. A failed change is never marked retryable, because the server
may already have committed it. The agent should read the cart before trying
again.

**Product names are untrusted.** Names come from an imported catalog, so the
read tools set `readOnlyHint` and `untrustedContentHint`. The mutation
receipt contains no names and has no annotations. Hints guide an agent.
Backend validation and the human checkout step enforce the rules.

**Descriptions ask for a final quantity.** In an early live `fx` run, a model
guessed a quantity for an ambiguous request. The tool and parameter
descriptions now ask for an explicit final quantity. This is guidance to the
model, not a guarantee.

**A tool returns after the page updates.** Each callback waits for the
backend result and for the Svelte DOM update, so the agent and the person see
the same cart.

## Design goals

The tools serve three user goals. `tests/webmcp/evals.json` turns these into
eight evaluation cases.

1. **Browse without changing the cart.** "Which products are available?"
   calls `list_products` and follows `next_offset`. An empty catalog returns an
   empty page. Imported text such as "ignore the user" stays data.
2. **Set an explicit final quantity.** "Set Coffee to exactly two" calls
   `get_cart`, then `set_cart_quantity`. If the user gives no final quantity,
   the agent asks. After a conflict or a lost response, it reads the cart
   before it retries.
3. **Hand checkout to the person.** "How do I order this?" calls `get_cart`
   and tells the user to open **Cart**, choose **Review order**, and confirm
   it themselves. No tool creates a quote or an order.

To run the evaluations, see
[Develop and verify a change](../README.md#check-the-webmcp-tools). The
evaluator measures tool choice and arguments against mock results. It does
not check the live UI, backend authorization, or the tone of the reply.

## Registration and cleanup

`registerWebMcpTools()` reads `document.modelContext` and registers the tools
one at a time under one `AbortController`. It returns a cleanup function that
the page calls on unmount. Each call combines its own execution signal with
the registration signal, so cleanup also cancels running requests and queued
writes. Cancellation can't undo a write the server already committed.

If one registration fails, the helper aborts the signal, which removes the
earlier registrations, and reports the error. Cleanup during a pending
registration stops the remaining ones without reporting an error.

If `document.modelContext` is missing, the page skips registration. The UI
and `fx` keep working. Registration also runs independently of `fx` startup, so
the tools work when the Gateway key is missing or `fx` fails to start. `fx` needs
WebAssembly JSPI, which is a separate browser feature from WebMCP.

An account change or sign-out cancels `fx` turns, closes the agent, clears
chat, and unregisters the tools. Callbacks bound to the old account stop
working.

## Limits

- The catalog is fixed. fx-web does not listen for WebMCP `toolchange` and
  does not turn tools discovered through WebMCP into `fx` tools.
- Pages use offsets, not snapshot tokens. A catalog import between pages can
  shift rows.
- There is no relative "add one" tool. It would need its own semantics in the
  write queue.
- The tools exist only on the signed-in shop page. They expose no sign-in
  form, credential, quote, or order confirmation.
- Chrome's Lighthouse **Agentic browsing** audit lists the chat composer as
  an uncovered form. The composer is not a shopping tool, so it stays
  unregistered.
