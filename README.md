# fx-web

A shop where people and AI agents share one cart.

A person, the `fx` agent embedded in the page, external browser agents
(through WebMCP), and external MCP hosts all change the same cart. The backend
authenticates every action and owns prices, stock, and saved state. Only a
person can confirm an order.

fx-web is a local prototype. It runs as one SvelteKit server on a loopback
address and stores everything in one SQLite file.

## Demos

The clips are edited to show UI and cart states. They don't show latency or
prove that no backend requests happen. To reproduce them and inspect the
requests, follow the [demonstration guide](docs/demonstrate.md).

### Share the cart with `fx`

The UI and `fx` change the same cart. After a Coffee is added through a card and
its quantity raised in **Cart**, `fx` reads back two coffees.

![fx product card, Coffee cart, and reply reporting two coffees](docs/assets/01%20coffee-shared-state.gif)

### Call page tools through WebMCP

External browser agents discover and call the page's shopping tools. The cart
goes from empty to one Plant.

![An empty cart and a cart containing one Plant](docs/assets/02%20plant-webmcp.gif)

### Use MCP Apps inside chat

MCP Apps put shop controls in fx-web's chat and in Codex. Card buttons call
tools directly, without another model turn.

![Coffee product card in fx-web and an interactive shop MCP App in Codex](docs/assets/03%20mcp-app-cart-cart.gif)

### Restore a completed conversation

After a reload, fx-web restores the saved `fx` checkpoint and the chat history.
The cart still holds one coffee at €5.00, and no shopping action runs again.

![Saved conversation restored after reload with one Coffee in the cart](docs/assets/04%20checkpoint-restoration.gif)

## Documentation

- [Architecture](docs/architecture.md) explains how the actors share the
  backend and maps the code and tests.
- [WebMCP](docs/webmcp.md) covers the page's tools and why they are shaped
  that way.
- [MCP Apps](docs/mcp-apps.md) covers the chat host, the `/mcp` shop provider,
  OAuth, and sandboxing.
- [Conversation persistence](docs/chat-history.md) covers saved chat,
  unfinished turns, and failed saves.
- [Demonstrate shared state and agent actions](docs/demonstrate.md) walks
  through each actor and the network requests it makes.

## Get started

### Prepare the environment

You need macOS or Linux with:

- Node.js 26.3 or later, for native TypeScript, `node:sqlite`, and the
  WebAssembly JSPI that the `fx` integration tests use.
- pnpm 11.5.2, as pinned in `package.json`.
- [Task](https://taskfile.dev/installation/) 3.48 or later.

`fx` chat needs a browser with WebAssembly JavaScript Promise Integration
(JSPI). WebMCP needs its own browser support. Chrome 157 enables it only with
`--enable-features=WebMCP`, which `task browser` passes.

Run every `task` command from this directory. From elsewhere, use
`task -d /path/to/fx-web <task>`.

Copy the template to `.env.fx`, which is ignored and loaded by every task:

```bash
cp .env.fx.example .env.fx
```

Set `AI_GATEWAY_API_KEY` in it, or export it in your shell, which takes
precedence. The shop works without a key. Only `fx` chat needs it. Never put
the Gateway key or `BETTER_AUTH_SECRET` in client code or a `VITE_*` variable.

### Install and start the server

```bash
task install
task auth-setup
task dev -- --host 127.0.0.1 --port 5173 --strictPort
```

`auth-setup` adds a `BETTER_AUTH_SECRET` to `.env.fx` if one is missing. It
never prints or replaces an existing credential. `--strictPort` fails on a
port conflict instead of picking another port.

Open `http://127.0.0.1:5173/` and choose **Create an account**. After sign-in
the shop opens, and the header shows the model and **Agent ready**. That check
means `fx` started. It doesn't mean Gateway accepted your key.

### Import the example catalog

A new database has no products. Save this as `products.json`:

```json
[
	{ "id": "coffee", "name": "Coffee", "emoji": "☕", "currency": "EUR", "priceCents": 500, "stock": 10 },
	{ "id": "plant", "name": "Plant", "emoji": "🪴", "currency": "EUR", "priceCents": 1800, "stock": 10 },
	{ "id": "book", "name": "Book", "emoji": "📖", "currency": "EUR", "priceCents": 2400, "stock": 10 }
]
```

From a second terminal, import it and reload the page:

```bash
task catalog-import FILE="$PWD/products.json"
```

An import sets stock for the products in the file and leaves the others
unchanged.

## Use the shop and chat

Click **Add** on a product, open **Cart** to change quantities, then ask `fx`
about the same cart:

> Add two coffees and one plant to my cart. Done means the cart shows those additional quantities and fx reports the total. Keep existing items and require my explicit approval before recording an order.

### Record an order

1. Click **Review order** to get a quote with prices calculated by the server.
2. Check the items and the total.
3. Click **Confirm order** to record the order.

Confirming records the order and deducts stock in one transaction. The
prototype collects no payment, shipping, or tax, and no agent tool can
confirm an order. If the order shows a refresh warning, click
**Refresh cart**. The receipt stays visible, and shopping controls stay
disabled until the warning clears.

### Chat

Press Enter to send and Shift+Enter for a new line. **Stop reply** cancels a
turn. After each turn, the app saves the `fx` checkpoint and the chat history,
so a reload or a new sign-in restores the conversation. **New conversation**
clears chat and keeps the cart. The header's sign-out icon ends the session
and clears chat from the browser.

If a turn was interrupted, the app shows the unfinished prompt and blocks new
messages. A cart change from that turn may already have happened. Stop any
other tab that is running a reply, check your cart, then choose
**Discard unfinished turn**. The app goes back to the last saved checkpoint
and replays nothing. If a completed turn failed to save, **Retry save** writes
it again without running another turn. See
[Conversation persistence](docs/chat-history.md) for the other cases.

### Open an MCP App in chat

MCP Apps run in a sandbox server. Start it in another terminal and leave it
running:

```bash
task mcp-sandbox
```

The sandbox listens on `127.0.0.1:5174`. The shop loads apps from the
opposite loopback hostname, so a shop on `127.0.0.1` uses
`http://localhost:5174`. A different port alone would share the shop's
cookies.

To use other ports, pass `--port` and pass `--host-origin` once for each shop
origin. Set `FX_MCP_SANDBOX_ORIGIN` to the matching sandbox origin and restart
the shop:

```bash
task mcp-sandbox -- --port 5180 --host-origin http://127.0.0.1:5173
# .env.fx: FX_MCP_SANDBOX_ORIGIN=http://localhost:5180
```

Then ask `fx`:

> Show me a coffee. Done means an interactive Coffee card appears with its €5.00 price and Add to cart button. Keep my cart unchanged until I click Add to cart.

**Add to cart** calls MCP directly, without a model turn. Checkout from the
card opens the shop's review flow.

### Connect an external MCP host

1. Add `http://127.0.0.1:5173/mcp` to your MCP host. Use your server's origin
   if it differs.
2. Follow the host's authorization link.
3. Sign in to fx-web and review the requested scopes.
4. Approve, then list products or read the cart from the host.

If your client publishes HTTPS client metadata, first add its metadata URL and
any JWKS URL to `FX_MCP_CLIENT_METADATA_URLS` and restart the server. Read the
cart before calling `set_cart_quantity`, and pass its revision as
`expectedRevision`. Check inline app rendering in your host separately from
tool discovery. [MCP Apps](docs/mcp-apps.md#the-shop-provider) lists the
tools and the OAuth rules.

## Configuration

[`.env.fx.example`](.env.fx.example) lists every variable with its default
and purpose. Set them in `.env.fx` or the server's environment, then restart
the server. The server applies the same defaults when a variable is empty or
unset, so tests and scripts run without the file.

`http://127.0.0.1:5173/api/config` shows the model and whether a key is
`configured`. It never returns the key. If Gateway reports
`customer_verification_required`, complete verification in the Vercel
dashboard.

## Develop and verify a change

Stop the dev server before you build or test. Builds and tests share
`.svelte-kit/` and the generated output directories with it, and they can
reload its page. Run one task at a time per checkout.

Install Chromium for the browser tests once:

```bash
task browser-install
```

On Linux, add `-- --with-deps` if Chromium needs system libraries, which may
need administrator rights.

Format and verify:

```bash
task format
task verify
```

`verify` runs type checks, Node tests, lint, the production build, and the
browser tests, in that order. The browser tests take several minutes and use
their own server, account, database, and browser session. To rerun only them,
use `task test-browser`. [Architecture](docs/architecture.md#find-the-tests)
says what each test file covers.

Afterward, restart `task dev` with the same host and port. The same database
keeps your account and cart.

To find the code behind a behavior, use the
[code map](docs/architecture.md#find-the-code). While the dev server runs,
watch `/api` requests in the browser's Network panel and server errors in its
terminal.

### Rebuild the MCP App

`dev` and `build` regenerate `.outputs/mcp-shop/shop.html`. After editing
`src/mcp-ui/` while the server runs, run `task build-mcp-ui`. Open a new card
to load the new build. Open cards keep the version they loaded.

### Check the WebMCP tools

`task webmcp-schema` writes the tools' schemas to `.outputs/webmcp/schema.json`.
To run the eight model evaluations in `tests/webmcp/evals.json`, export the
evaluator's provider credentials in your shell, such as `OPENAI_API_KEY` and
`OPENAI_BASE_URL`, then run:

```bash
task webmcp-eval -- -b vercel -m openai:your-model-id --max-steps 8
```

Each run writes to a new `.outputs/webmcp/evals-*` directory. The task fails
on any mismatch or error, authentication errors included. A Gateway key that
works for `fx` may not work with the evaluator's OpenAI-compatible API.

To inspect the tools by hand, open Chrome DevTools **Application > WebMCP**
and use a tool's Play control.

### Check a journey in the browser

The [fx-web verification skill](.cursor/skills/verify-fx-web/SKILL.md) runs
the app with a disposable database and browser. Pick the journey that matches
your change:

- Chat: send, follow up, cancel, and reset.
- Checkout: review, confirm, and recover from a failed refresh.
- API: invalid requests fail before they reach Gateway.

### Preview the production build

```bash
task build
task preview -- --host 127.0.0.1 --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/` and repeat the browser check. Rebuild after each
source change. Preview is a local check, not a deployment setup. It uses the
same database and credentials as `dev`.

### Add a UI component

Install shadcn-svelte components through Task:

```bash
task cli-shadcn-svelte -- add button
```

Review the generated files and run `task verify`. Keep the upstream component
styles and the licensed Typeset stylesheet unchanged.

## Move an existing installation

Stop every server and importer that uses the database before you copy it.
Never copy only the main SQLite file while a server runs, because recent
writes live in its WAL sidecar.

To copy a database into this checkout, run:

```bash
task database-migrate FROM="/absolute/path/to/existing.sqlite"
```

The copy goes to the database that `FX_DATABASE_PATH` names.
The task includes committed WAL data, checks SQLite integrity, and refuses to
overwrite an existing database or sidecar. It leaves the source in place for
rollback. Don't run the old installation after the copy. Once you have
checked the new one, archive the old database together with its sidecars.

To move the project directory itself, stop the server, then move `.env.fx`,
the database, and its sidecars together, and run `task install` in the new
location. Keep `BETTER_AUTH_SECRET` unchanged. If `FX_DATABASE_PATH` points
outside the project, update it.

Browser cookies belong to the origin. Keep the same hostname and port to stay
signed in. After an origin change, sign in again, then update and reauthorize
external MCP connections.

## Before a public deployment

fx-web accepts only loopback hosts and same-origin mutations. A public
deployment needs at least this work:

- Choose a SvelteKit adapter and plan database operations for the target.
  `adapter-node` applies a 512 KB `BODY_SIZE_LIMIT` by default, which is below
  the 6 MiB that `/api/chat` accepts for checkpoints.
- Add per-user inference limits and a production identity policy.
- Connect catalog import to the real product and inventory source. Keep
  backend validation and human checkout when you add fulfillment.
- Support public MCP connections. The host accepts only a loopback remote
  server, and the provider serves only loopback clients.
