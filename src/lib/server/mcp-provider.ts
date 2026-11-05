import { Hono } from "hono";
import { limitRequestBody, loopbackHosts } from "./http.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
  emptySchema,
  productQuerySchema,
  mutationSchema,
  shopTools,
  matchesQuery,
  ApiError,
} from "../contract.ts";
import type { ShopIdentity } from "./commerce.ts";
import type { Runtime } from "./application-runtime.ts";

const shopResourceUri = "ui://fx-web/shop";
const mcpShopTools = shopTools.map(({ name, description }) => ({
  name,
  description:
    name === "list_products"
      ? "Display available product cards with prices in EUR and the current cart. For browsing interest, use query to match product names or IDs case-insensitively. This never changes the cart."
      : description,
}));

function shopServer(runtime: Runtime, identity: ShopIdentity) {
  const server = new McpServer({ name: "fx-web-shop", version: "0.0.1" });
  for (const tool of mcpShopTools) {
    // fx and WebMCP writes get their revision from the shared shop controller.
    // MCP clients hold their own cart view and must supply the revision they observed.
    const inputSchema =
      tool.name === "set_cart_quantity"
        ? mutationSchema
        : tool.name === "list_products"
          ? productQuerySchema
          : emptySchema;
    registerAppTool(
      server,
      tool.name,
      {
        description: tool.description,
        inputSchema,
        annotations: {
          readOnlyHint: tool.name !== "set_cart_quantity",
          destructiveHint: false,
          openWorldHint: false,
        },
        _meta: { ui: { resourceUri: shopResourceUri, visibility: ["model", "app"] } },
      },
      async (input) => {
        try {
          const payload = await runtime.operation(() => {
            switch (tool.name) {
              case "list_products": {
                const { query } = productQuerySchema.parse(input);
                const catalog = runtime.commerce.catalogFor(identity);
                return {
                  catalog: {
                    ...catalog,
                    products: query
                      ? catalog.products.filter((product) => matchesQuery(product, query))
                      : catalog.products,
                  },
                  cart: runtime.commerce.cartFor(identity),
                };
              }
              case "get_cart":
                return { cart: runtime.commerce.cartFor(identity) };
              case "set_cart_quantity": {
                // A write-only grant still gets its cart receipt, but no catalog it cannot read.
                const catalog =
                  !identity.delegation || identity.delegation.scopes.includes("shop:read")
                    ? runtime.commerce.catalogFor(identity)
                    : undefined;
                const cart = runtime.commerce.setQuantity(identity, mutationSchema.parse(input));
                return { cart, ...(catalog ? { catalog } : {}) };
              }
              default: {
                const _exhaustive: never = tool.name;
                throw new Error(`Unknown shopping tool: ${_exhaustive}`);
              }
            }
          });
          const text =
            tool.name === "list_products" && productQuerySchema.parse(input).query
              ? payload.catalog?.products.length
                ? "Matching products were found."
                : "No matching products were found."
              : JSON.stringify(
                  tool.name === "set_cart_quantity" ? { cart: payload.cart } : payload,
                );
          return {
            content: [{ type: "text", text }],
            structuredContent: payload,
            _meta: { shopUrl: new URL("/", runtime.resource).href },
          };
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          return {
            isError: true,
            content: [{ type: "text", text: error.message }],
            structuredContent: {
              error: error.message,
              ...error.detail,
            },
          };
        }
      },
    );
  }
  registerAppResource(server, "shop", shopResourceUri, {}, async () => ({
    contents: [
      {
        uri: shopResourceUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(resolve(".outputs/mcp-shop/shop.html"), "utf8"),
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      },
    ],
  }));
  return server;
}

export function createShopMcpHandler(runtime: Runtime, identity: ShopIdentity) {
  return createMcpHandler(() => shopServer(runtime, identity), {
    legacy: "reject",
    maxRequestBodySize: 64 * 1024,
  });
}

function createProtectedShopMcp(runtime: Runtime) {
  // The stateless SDK transport clones requests; verified identity follows the async call instead.
  const principals = new AsyncLocalStorage<ShopIdentity>();
  const handler = createMcpHandler(
    () => {
      const identity = principals.getStore();
      if (!identity) throw new Error("MCP principal is required.");
      return shopServer(runtime, identity);
    },
    { legacy: "stateless", maxRequestBodySize: 64 * 1024 },
  );
  const authenticated = runtime.protectMcp((request, identity) =>
    principals.run(identity, () => handler.fetch(request)),
  );
  runtime.onSessionEnd((identity) => {
    if (!identity) void handler.close();
  });
  return authenticated;
}

// Native MCP hosts use bearer tokens and form-encoded OAuth requests, rather than
// the browser API's mandatory Origin and JSON rules. Route only protocol paths here.
const protocolPaths = new Set([
  "/api/auth/jwks",
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/introspect",
  "/api/auth/.well-known/oauth-authorization-server",
  "/api/auth/.well-known/openid-configuration",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/api/auth",
]);
export const isMcpProtocolPath = (path: string) =>
  path === "/mcp" || protocolPaths.has(path) || path.startsWith("/.well-known/");
const provider = new WeakMap<Runtime, ReturnType<typeof createProtectedShopMcp>>();
const windows = new Map<string, { until: number; count: number }>();
export const mcpHttp = new Hono<{ Bindings: { runtime: Runtime } }>();
mcpHttp.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const origin = c.req.header("origin");
  if (!loopbackHosts.includes(url.hostname) || (origin && origin !== url.origin))
    return c.json({ error: "Use the configured local MCP endpoint." }, 403);
  c.header("Cache-Control", "no-store");
  // A fixed one-minute window of 120 requests per socket address. Clearing at 1,024
  // addresses bounds memory, but it also resets every window.
  const key = c.req.header("x-real-ip") || "local";
  const now = Date.now();
  const current = windows.get(key);
  if (current && current.until > now) {
    if (++current.count > 120) return c.json({ error: "MCP rate limit reached." }, 429);
  } else {
    if (windows.size >= 1024) windows.clear();
    windows.set(key, { until: now + 60_000, count: 1 });
  }
  await next();
});
mcpHttp.use("*", limitRequestBody);
mcpHttp.all("/mcp", (c) => {
  let handler = provider.get(c.env.runtime);
  if (!handler) {
    handler = createProtectedShopMcp(c.env.runtime);
    provider.set(c.env.runtime, handler);
  }
  return handler(c.req.raw);
});
mcpHttp.all("*", (c) => {
  if (!protocolPaths.has(new URL(c.req.url).pathname)) return c.notFound();
  return c.env.runtime.handle(c.req.raw);
});
