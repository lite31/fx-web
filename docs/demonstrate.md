# Demonstrate shared state and agent actions

Use this guide to compare UI actions, WebMCP calls, and embedded `fx` turns in
the same shop. For the request flow and security checks, see
[Architecture](architecture.md).

## Prepare the shop

Use a test account for this demonstration:

1. Follow [Get started](../README.md#get-started).
2. Sign in with a test account.
3. Import the example catalog and confirm that Coffee, Plant, and Book appear.
4. Inspect the cart before changing quantities.

For an isolated database and browser, use the
[fx-web verification skill](../.cursor/skills/verify-fx-web/SKILL.md).
To include MCP App buttons, start the sandbox and open a card with the
[MCP App setup guide](../README.md#open-an-mcp-app-in-chat).

## Demonstrate the coffee card and shared cart

Use the example Coffee price of €5 and an empty disposable cart:

1. Ask `fx`:

   > I'd like a coffee. Done means an interactive Coffee card appears. Keep my cart unchanged until I click Add to cart.

2. Wait for the Coffee card and **Reply complete.**
3. Click the card's **Add to cart** button. Confirm that **Cart** shows one item.
4. Open **Cart**. Confirm that Coffee has quantity one and a €5 total.
5. Increase Coffee's quantity to two. Confirm that the total becomes €10.
6. Close **Cart** and ask `fx`:

   > Read my cart. Done means your reply reports the current Coffee quantity. Keep all cart quantities unchanged.

7. Confirm that `fx` reports two coffees.

The button calls MCP without another model turn. The final question starts a
new `fx` turn that reads the cart changed through the UI.

Watch the [shared-cart demo](../README.md#share-the-cart-with-fx) and
[MCP Apps demo](../README.md#use-mcp-apps-inside-chat) for the UI states.
Model wording and card selection can vary. If you capture your own demo,
scroll **Conversation** until the question and reply are visible.

## Discover and invoke the page's tools

WebMCP is experimental. Check browser support before this demonstration.

1. Enable WebMCP with [Chrome's local setup instructions](https://developer.chrome.com/docs/ai/webmcp#local-webmcp).
   Chrome 157 needs the `--enable-features=WebMCP` launch flag.
2. Open fx-web's DevTools console.
3. Check that the methods needed for this demonstration are available:

```js
typeof document.modelContext?.registerTool === "function";
typeof document.modelContext?.getTools === "function";
typeof document.modelContext?.executeTool === "function";
```

Require all three results to be `true`. If a method is missing, use a browser
that supports it before continuing. The
[WebMCP draft](https://webmachinelearning.github.io/webmcp/#api) defines these
methods on `document.modelContext`.

List the registered tools and read the cart:

```js
const context = document.modelContext;
const tools = await context.getTools();
console.table(tools.map(({ name, description }) => ({ name, description })));

const getCart = tools.find((tool) => tool.name === "get_cart");
if (!getCart) throw new Error("The page has not exposed get_cart.");
const cart = JSON.parse(await context.executeTool(getCart, {}));
console.log(cart);
```

To demonstrate a mutation, run the following code in the same console. It
replaces Coffee's existing quantity with two. Use your test account.

```js
const setQuantity = tools.find((tool) => tool.name === "set_cart_quantity");
if (!setQuantity) throw new Error("The page has not exposed set_cart_quantity.");
await context.executeTool(setQuantity, { product_id: "coffee", quantity: 2 });
```

Open **Cart** and confirm that Coffee has quantity two and a €10 line total.
Other items contribute to the cart total. To remove Coffee, repeat the call
with `quantity: 0`.

After navigation or reload, rediscover tools before calling them. Registrations
belong to the document, while the cart persists on the backend. For a graphical
consumer, use Chrome's
[Model Context Tool Inspector](https://developer.chrome.com/docs/ai/webmcp#imitate-agent-chat-with-the-inspector-extension).

### Call the page tools from a Codex chat

To call the page's tools, follow these steps:

1. Open the signed-in app in Codex's browser.
2. Ask Codex "Buy me a plant in fx-web." The tool adds a plant to the cart and
   records no order. For a precise prompt that keeps existing items, use this
   one:

   > Add one plant to my fx-web cart. Done means the page's get_cart tool confirms the plant quantity increased by one. Keep existing cart items and require my explicit approval before recording an order.

Codex's browser integration discovers the page's tool catalog. To inspect the
sequence in code, obtain the tab handle and fetch the tool descriptions:

```js
const webmcp = await tab.capabilities.get("webmcp");
const tools = await webmcp.fetchTools();
await tools.description();
```

Use the complete names from that catalog, including any registration suffixes.
For an empty cart, the call sequence below sets Plant's quantity to one.
For a nonempty cart, read the existing quantity and use that quantity plus one.
Replace the tool-name placeholders with names from the current discovery result:

```js
await tools.call("<discovered get_cart name>", {});
await tools.call("<discovered set_cart_quantity name>", {
	product_id: "plant",
	quantity: 1
});
```

Confirm that **Cart** shows the updated Plant quantity. These calls use the
page's authenticated controller and business API. They do not start a turn in
the embedded `fx` agent.

To call the same native WebMCP tools through the project's pinned browser CLI,
open the signed-in app in that browser session and run these Task commands:

```bash
task browser -- webmcp list --json
task browser -- webmcp invoke get_cart --params '{}' --json
task browser -- webmcp invoke list_products --params '{}' --json
task browser -- webmcp invoke set_cart_quantity --params '{"product_id":"plant","quantity":1}' --json
task browser -- webmcp invoke get_cart --params '{}' --json
```

Use the same browser session for every command. With the verification helper,
use `task -t "$FX_VERIFY_TASK" browser -- ...` instead of `task browser -- ...`.
The example sets Plant's final quantity to one. Inspect the cart and catalog
first to decide the quantity to send.

The [Plant demo](../README.md#call-page-tools-through-webmcp) illustrates the
cart states. It does not display a tool-call transcript. The commands above
use native page tools, not the separate backend `/mcp` connection. Discover
tools again after navigation or reload.

### Call tools in your existing Chrome tab

To connect Codex to your existing Chrome tab, follow these steps:

1. Check the browser requirements in [Chrome's WebMCP debugging guide](https://developer.chrome.com/docs/devtools/agents/webmcp-debugging).
2. Enable WebMCP and sign in to fx-web in Chrome.
3. Open `chrome://inspect/#remote-debugging` and enable incoming connections.
4. Configure the official [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp) with the entry below.

Merge this entry into your Codex MCP configuration. The
[`--autoConnect` option](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#automatically-connecting-to-a-running-chrome-instance)
attaches to the running Chrome profile.

```toml
[mcp_servers.chrome_webmcp]
command = "pnpm"
args = ["dlx", "chrome-devtools-mcp@latest", "--autoConnect", "--categoryExperimentalWebmcp"]
enabled_tools = ["list_pages", "list_webmcp_tools", "execute_webmcp_tool"]
```

5. Reconnect the MCP server.
6. Accept Chrome's connection prompt.
7. Ask Codex:

> Add one plant to my cart in the existing fx-web Chrome tab using only WebMCP. Done means get_cart confirms the updated quantity. Keep my existing items and do not record an order without my approval.

Confirm that the agent selects the fx-web tab with `list_pages` and discovers
its tools with `list_webmcp_tools`. The cart mutation must use
`execute_webmcp_tool`. Check the resulting quantity in **Cart**. Checkout
confirmation stays in the shop UI.

## Establish browser-side WASM execution

A ready indicator or a downloaded `.wasm` file alone does not establish that
`fx` executed a tool in the browser. Capture the runtime and its callback together:

1. Open DevTools before reloading the signed-in app.
2. In **Network**, select **All** and filter for `fx-core.wasm`.
3. Confirm that the `fx` module loads.
4. Clear the filter and ask `fx` for a read-only diagnostic:

   > Read my cart with the direct get_cart tool, not shop__get_cart. Done means your reply reports the current Coffee quantity from its result. Keep cart quantities unchanged and do not open another card.

5. Select the resulting `/api/cart` request and inspect **Initiator**.
6. Capture the browser call stack, the visible reply, and the cart quantity.

For a direct `get_cart` call, inspect frames from `fx-core.wasm`, libfx's
`executeHostTool`, the shop's `execute` callback, and `getCart` before the fetch.
Locations refer to browser-served source, so line numbers can differ from
repository TypeScript. CPU samples containing functions from the WASM module
can provide additional execution evidence. They do not establish a speed advantage.

Hosted MCP tools also have browser-side callbacks, but those call the backend
MCP client. Use the direct tool for this diagnostic so its callback leads to
`/api/cart`.

## Demonstrate shared state and network boundaries

For the `fx` comparison, first wait for the header's **Agent ready** check.
UI and WebMCP actions do not require `fx` to be ready.

Compare the requests from each action:

1. Inspect the cart and record its starting quantities.
2. Open the [Network panel](https://developer.chrome.com/docs/devtools/network/).
3. Select **Fetch/XHR** and clear the log.
4. Click **Add** on Coffee's card. Confirm that `/api/cart/quantity` completes and the cart updates.
5. Read the cart with WebMCP's `get_cart`. Confirm that the result matches the UI.
6. Change Coffee's quantity with `set_cart_quantity`. Confirm that the UI updates and a business request appears. Expect no `/api/generate` request.
7. Ask embedded `fx` to read and change the cart. Expect `/api/generate` requests for inference. `/api/models` supplies model capabilities, and `/api/chat` stores prompts and checkpoints.
8. If `fx` uses direct shop tools, inspect `/api/cart`, `/api/catalog`, and `/api/cart/quantity`.
9. If `fx` uses hosted MCP tools, inspect `/api/mcp/conversations/:id/call`. Confirm that the page's cart refreshes after a shop call.
10. Click an MCP App button. Inspect `/api/mcp/conversations/:id/views/:viewId/call`. Confirm that the action needs no new model turn.
11. Wait for the reply to finish saving. Reload the page. Confirm that the cart and completed chat return without another `/api/generate` or cart mutation. Saved MCP App entries show titles without interactive frames.
12. Sign out. Sign in again and confirm that the same cart and chat return.
13. Sign in with another account. Confirm that the account has its own cart and chat.

For interruption and failed-save checks, follow [conversation recovery](chat-history.md).

If you are authorized to record a test order, click **Review order** and inspect
the quote. Stock must remain unchanged until you click **Confirm order**.

To demonstrate the backend requirement, take the app offline. Attempt a cart
change and confirm that the mutation fails. Restore connectivity before continuing.

Do not present an absence of model calls as an absence of backend requests.
For the reason, see [Model requests and business requests](architecture.md#model-requests-and-business-requests-are-separate).
To claim a latency improvement, measure the same workflow in both systems.

Use these categories when presenting the recorded requests:

| Request | Responsibility |
| --- | --- |
| `GET /api/models` | Model capabilities, not inference. |
| `POST /api/generate` | The server proxies remote model inference and keeps Gateway credentials private. |
| `/api/cart`, `/api/catalog`, `/api/cart/quantity` | Authenticated business reads or mutations. |
| `/api/mcp/conversations/:id/call` | A browser tool callback calls the backend MCP client. |
| `/api/mcp/conversations/:id/views/:viewId/call` | An MCP App button or app refresh calls through the host. |
| `POST /api/chat` with `begin` | Save an unfinished-turn marker before inference. |
| `POST /api/chat` with `complete` | Save the completed checkpoint and displayed history. |

Before reloading, confirm that `/api/chat` acknowledges a `complete` write with
a nonempty checkpoint. During reload, check for history and business reads,
without a new `/api/generate` request, cart mutation, or MCP tool call.
Compare the cart quantity and total before and after reload.

The [restoration demo](../README.md#restore-a-completed-conversation) shows
the resulting UI states for a completed turn. For unfinished turns, see
[Conversation persistence](chat-history.md).

## What the demos do not show

`fx` runs in the browser, but it still needs remote inference and the backend's
state and storage. These demos do not show offline operation, a speed
advantage, or an absence of backend requests.

Do not publish raw network exports containing cookies, headers, request
bodies, checkpoints, or credentials. Use disposable accounts and publish only
the fields needed to support each claim.
