import { tick } from "svelte";
import { z } from "zod";
import type { WebMCP } from "webmcp-types";
import { cartSchema, catalogSchema, quantitySchema, type Product } from "./contract.ts";
import type { Shop } from "./shop.ts";

const readSchema = z.strictObject({
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Continuation offset returned by the previous page; omit for the first page."),
});

const inputSchema = quantitySchema.extend({
  product_id: quantitySchema.shape.product_id.describe(
    "Product ID returned by list_products or get_cart.",
  ),
  quantity: quantitySchema.shape.quantity.describe(
    "Final quantity explicitly requested by the user. Ask if unspecified; never guess. Zero removes the product.",
  ),
});

const descriptions = {
  list_products:
    "Read available products and prices. Use when browsing or identifying a product before changing the cart. Follow next_offset to read more.",
  get_cart:
    "Read current cart items and authoritative totals. Use to inspect the cart before or after a change. Follow next_offset to read more.",
  set_cart_quantity:
    "Change a product to the user's explicit final cart quantity, or remove it. Ask for the final quantity when unspecified; never guess or retry a failed change without rereading the cart. This does not record an order.",
} satisfies Record<Shop["tools"][number]["name"], string>;

// Product names come from an imported catalog. Capping a name's JSON at 600 characters
// keeps any single row within a 1,500-character page.
function label(product: Pick<Product, "id" | "name">) {
  let name = "";

  for (const character of product.name) {
    if (JSON.stringify(name + character).length > 600) break;
    name += character;
  }

  return name === product.name
    ? { id: product.id, name }
    : { id: product.id, name, nameTruncated: true };
}

// Bound each serialized reply without splitting an item.
// shortcut: concurrent edits can shift offset pages. Use snapshot cursors if stable
// multi-page reads become necessary. Cart readers can detect a changed revision.
function page<T>(
  summary: Record<string, string | number>,
  key: "products" | "items",
  items: T[],
  offset: number,
) {
  const selected: T[] = [];

  const result = {
    ...summary,
    [key]: selected,
    offset,
    page_size: 0,
    total_count: items.length,
    next_offset: offset < items.length ? offset : null,
  };

  for (const item of items.slice(offset)) {
    selected.push(item);
    result.page_size = selected.length;
    const next = offset + selected.length;
    result.next_offset = next < items.length ? next : null;

    if (JSON.stringify(result).length > 1500) {
      selected.pop();
      result.page_size = selected.length;
      result.next_offset = offset + selected.length;
      break;
    }
  }

  if (!selected.length && offset < items.length)
    throw new Error("A product exceeds the tool response limit. Inspect it in the shop.");

  return JSON.stringify(result);
}

export function createWebMcpTools(
  tools: Shop["tools"],
  registrationSignal: AbortSignal,
): WebMCP.ModelContextTool[] {
  return tools.map((tool) => {
    const native: WebMCP.ModelContextTool = {
      name: tool.name,
      description: descriptions[tool.name],
      inputSchema: z.toJSONSchema(tool.name === "set_cart_quantity" ? inputSchema : readSchema, {
        target: "draft-7",
      }),
      async execute(input, { signal }) {
        const execution = AbortSignal.any([signal, registrationSignal]);

        try {
          execution.throwIfAborted();

          const validation =
            tool.name === "set_cart_quantity"
              ? inputSchema.safeParse(input)
              : readSchema.safeParse(input);

          if (!validation.success) {
            await tick();
            execution.throwIfAborted();

            return JSON.stringify({
              code: "INVALID_INPUT",
              error: "Invalid arguments. Use the tool's input schema.",
              retryable: false,
            });
          }

          const parsed = validation.data;

          const raw: unknown = JSON.parse(
            await tool.execute("product_id" in parsed ? parsed : {}, { signal: execution }),
          );

          let result: string;

          if ("product_id" in parsed) {
            const { revision, currency, count, subtotalCents, totalCents } = cartSchema.parse(raw);
            result = JSON.stringify({
              ...parsed,
              revision,
              currency,
              count,
              subtotalCents,
              totalCents,
            });
          } else if (tool.name === "list_products") {
            const { currency, products } = catalogSchema.parse(raw);
            result = page(
              { currency },
              "products",
              products.map((product) => ({
                ...label(product),
                priceCents: product.priceCents,
                stock: product.stock,
              })),
              parsed.offset ?? 0,
            );
          } else {
            const { revision, currency, count, subtotalCents, totalCents, items } =
              cartSchema.parse(raw);

            result = page(
              { revision, currency, count, subtotalCents, totalCents },
              "items",
              items.map((item) => ({
                ...label(item),
                quantity: item.quantity,
                lineTotalCents: item.lineTotalCents,
              })),
              parsed.offset ?? 0,
            );
          }

          // Let Svelte publish the shared shop update to the DOM before resolving
          // the tool call, so DOM observers can see the completed change.
          await tick();
          execution.throwIfAborted();

          return result;
        } catch (cause) {
          // Resolve failures as data, because a rejected callback reaches the agent only as a
          // generic browser error. Nothing is retryable: a failed change may already be committed.
          await tick();

          const cancelled =
            execution.aborted || (cause instanceof Error && cause.name === "AbortError");

          return JSON.stringify({
            code: cancelled ? "CANCELLED" : "REQUEST_FAILED",
            error: cancelled
              ? "Tool cancelled. Read the cart before retrying a change."
              : cause instanceof Error
                ? cause.message.slice(0, 160)
                : "The shop request failed.",
            retryable: false,
          });
        }
      },
    };

    if (tool.name !== "set_cart_quantity")
      native.annotations = { readOnlyHint: true, untrustedContentHint: true };

    return native;
  });
}

// Registers the tools one at a time under one signal. Aborting that signal removes every
// registration, so both the returned cleanup and a failed registration leave no tools behind.
// Cleanup while registration is still running reports no error.
export function registerWebMcpTools(tools: Shop["tools"], reportError: (message: string) => void) {
  const context = document.modelContext;
  const registration = new AbortController();

  if (context)
    void (async () => {
      try {
        for (const tool of createWebMcpTools(tools, registration.signal)) {
          registration.signal.throwIfAborted();
          await context.registerTool(tool, { signal: registration.signal });
        }
      } catch {
        const cancelled = registration.signal.aborted;
        registration.abort();

        if (!cancelled)
          reportError("WebMCP registration failed. Shopping and fx tools remain available.");
      }
    })();

  return () => registration.abort();
}
