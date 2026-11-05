import { z } from "zod";
import { CallToolResultSchema } from "@modelcontextprotocol/core";

// This is an account expectation, not a credential. The server compares it with
// the cookie session so an old tab cannot act on a newly signed-in account.
export const expectedUserHeader = "x-fx-user-id";

export const modelConfigSchema = z.object({ model: z.string().min(1), configured: z.boolean() });
export const streamedErrorSchema = z.object({ type: z.literal("error"), error: z.string() });

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const price = integer.max(1_000_000_000);
const inventory = integer.max(1_000_000);
export const credentialsSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9_.-]+$/),
  password: z.string().min(12).max(128),
});
const userSchema = z.strictObject({ id: identifier, username: z.string() });
export const signupSchema = credentialsSchema.extend({ email: z.email().max(254) });
export const authUserSchema = z
  .object({
    user: z.object({
      id: identifier,
      name: z.string(),
      username: z.string().nullable().optional(),
    }),
  })
  .transform(({ user }) => ({
    user: userSchema.parse({ id: user.id, username: user.username ?? user.name }),
  }));
export const sessionSchema = authUserSchema
  .nullable()
  .transform((session) => session ?? { user: null });
export const authErrorSchema = z
  .object({ message: z.string() })
  .transform(({ message }) => ({ error: message }));
export const productSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(200),
  emoji: z.string().max(32),
  currency: z.literal("EUR"),
  priceCents: price,
  stock: inventory,
  active: z.boolean(),
});
export const catalogImportSchema = z
  .array(productSchema.extend({ active: z.boolean().default(true) }))
  .max(1000)
  .refine(
    (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
    "Product IDs must be unique.",
  );
export const catalogSchema = z.strictObject({
  currency: z.literal("EUR"),
  products: z.array(productSchema).max(1000),
});
export const emptySchema = z.strictObject({});
export const productQuerySchema = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
});
export const quantitySchema = z.strictObject({ product_id: identifier, quantity: integer.max(99) });
export const mutationSchema = quantitySchema.extend({ expectedRevision: integer });
export const lineSchema = productSchema.extend({
  quantity: integer.min(1).max(99),
  lineTotalCents: integer,
});
export const cartSchema = z.strictObject({
  revision: integer,
  currency: z.literal("EUR"),
  items: z.array(lineSchema).max(1000),
  count: integer,
  subtotalCents: integer,
  totalCents: integer,
});
export const quoteSchema = cartSchema.extend({ id: identifier, expiresAt: integer });
export const confirmSchema = z.strictObject({ quoteId: identifier });
export const orderSchema = cartSchema.extend({ id: identifier, createdAt: integer });
export const errorSchema = z.object({
  error: z.string(),
  cart: cartSchema.optional(),
  code: z.literal("conversation_limit").optional(),
});
export type Product = z.infer<typeof productSchema>;
export type Cart = z.infer<typeof cartSchema>;
type ErrorBody = z.infer<typeof errorSchema>;
export class ApiError extends Error {
  // The browser rebuilds ApiError from any response status, including platform 429s and 500s.
  readonly status: number;
  readonly detail: Omit<ErrorBody, "error">;
  constructor(message: string, status: number, detail: Omit<ErrorBody, "error"> = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
  toJSON(): ErrorBody {
    return { error: this.message, ...this.detail };
  }
}
export const conversationLimitError: ErrorBody = {
  error: "This conversation reached its limit. Start a new conversation to continue.",
  code: "conversation_limit",
};
export type Quote = z.infer<typeof quoteSchema>;
export type Order = z.infer<typeof orderSchema>;
export type User = z.infer<typeof userSchema>;
const priceFormatter = new Intl.NumberFormat("en", { style: "currency", currency: "EUR" });
export const formatPrice = (cents: number) => priceFormatter.format(cents / 100);
export function matchesQuery(product: Pick<Product, "id" | "name">, query: string) {
  const match = query.toLowerCase();
  return product.name.toLowerCase().includes(match) || product.id.toLowerCase().includes(match);
}
const descriptor = <const Name extends string>(
  name: Name,
  description: string,
  schema: typeof emptySchema | typeof quantitySchema,
) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(schema, { target: "draft-7" }),
});
export const shopTools = [
  descriptor(
    "list_products",
    "List available products, stock, IDs and prices in EUR cents.",
    emptySchema,
  ),
  descriptor(
    "get_cart",
    "Read the authenticated cart and server totals. Read before changing quantities.",
    emptySchema,
  ),
  descriptor(
    "set_cart_quantity",
    "Set an absolute cart quantity from 0 to 99. Zero removes it. Only change the cart when asked. This does not place an order.",
    quantitySchema,
  ),
];

const id = z.string().min(1).max(128);
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const chatBodyLimit = 6 * 1024 * 1024;
const checkpointLimit = 4 * 1024 * 1024;
// The backend validates the envelope and size, not fx's opaque checkpoint format.
// Display history is stored separately so rendering never requires executing a checkpoint.
const checkpoint = z
  .string()
  .min(4)
  .max(Math.ceil(checkpointLimit / 3) * 4)
  .refine((value) => {
    if (value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) return false;
    try {
      const bytes = atob(value);
      return bytes.length <= checkpointLimit && btoa(bytes) === value;
    } catch {
      return false;
    }
  }, "Invalid checkpoint encoding.");
const chatMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    id,
    role: z.enum(["user", "assistant"]),
    text: z.string().max(16_000),
  }),
  z.strictObject({ kind: z.literal("app"), id, title: z.string().max(200) }),
]);
const messages = z
  .array(chatMessageSchema)
  .max(128)
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 512 * 1024,
    "Chat history is too large. Start a new conversation.",
  );
export const chatSnapshotSchema = z.strictObject({
  revision,
  checkpoint: checkpoint.nullable(),
  messages,
  limited: z.boolean(),
  pending: z
    .strictObject({ turnId: z.uuid(), prompt: z.string().trim().min(1).max(2000) })
    .nullable(),
});
const command = { revision, operationId: z.uuid() };
export const chatCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...command,
    kind: z.literal("begin"),
    turnId: z.uuid(),
    prompt: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({
    ...command,
    kind: z.literal("complete"),
    turnId: z.uuid(),
    checkpoint,
    messages,
    limited: z.boolean(),
  }),
  z.strictObject({ ...command, kind: z.literal("discard"), turnId: z.uuid() }),
  z.strictObject({ ...command, kind: z.literal("reset") }),
]);
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type ChatCommand = z.infer<typeof chatCommandSchema>;

export const conversationHeader = "x-fx-conversation-id";
export const hostedToolSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
});
export const hostConversationSchema = z.object({
  id,
  tools: z.array(hostedToolSchema).max(32),
  sandboxOrigin: z.url(),
});
export const hostViewSchema = z.object({
  id,
  title: z.string().max(200),
  html: z.string().max(512_000),
  input: z.record(z.string(), z.unknown()),
  result: CallToolResultSchema,
});
export const hostInvocationSchema = z.object({
  text: z.string().max(16_000),
  view: hostViewSchema.optional(),
});
export const hostCallSchema = z.strictObject({
  name: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
});
export type HostedTool = z.infer<typeof hostedToolSchema>;
export type HostConversation = z.infer<typeof hostConversationSchema>;
export type HostView = z.infer<typeof hostViewSchema>;
export type HostInvocation = z.infer<typeof hostInvocationSchema>;
