import {
  ApiError,
  emptySchema,
  mutationSchema,
  confirmSchema,
  hostCallSchema,
  chatCommandSchema,
} from "../contract.ts";
import type { Runtime } from "./application-runtime.ts";
import { ZodError } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { generate, models } from "./gateway.ts";
import { localRequests, limitRequestBody, requireJson } from "./http.ts";
import { mcpClientFor, type ApprovedRemote } from "./mcp-client.ts";
import { defaultSandboxPort } from "./env-defaults.ts";
import { Hono } from "hono";

export type Environment = {
  Bindings: {
    gatewayKey?: string;
    model: string;
    runtime: Runtime;
    sandboxOrigin?: string;
    approvedRemote?: ApprovedRemote;
  };
};

export const api = new Hono<Environment>().basePath("/api");
api.use("*", localRequests);
api.use("*", limitRequestBody);
api.use("*", requireJson);
api.get("/config", (c) => c.json({ model: c.env.model, configured: Boolean(c.env.gatewayKey) }));
api.on(["GET", "POST"], "/auth/*", (c) => c.env.runtime.handle(c.req.raw));
api.get("/chat", async (c) => {
  return c.json(
    await c.env.runtime.authorized(c.req.raw.headers, (who) =>
      c.env.runtime.chatHistory.load(who.userId),
    ),
  );
});
api.post("/chat", async (c) => {
  const input = chatCommandSchema.parse(await c.req.json());
  return c.json(
    await c.env.runtime.authorized(c.req.raw.headers, (who) =>
      c.env.runtime.chatHistory.change(who.userId, input),
    ),
  );
});
api.get("/models", models);
api.get("/catalog", async (c) => {
  return c.json(
    await c.env.runtime.authorized(c.req.raw.headers, () => c.env.runtime.commerce.catalog()),
  );
});
api.get("/cart", async (c) => {
  return c.json(
    await c.env.runtime.authorized(c.req.raw.headers, (who) =>
      c.env.runtime.commerce.cart(who.userId),
    ),
  );
});
api.post("/cart/quantity", async (c) => {
  const input = mutationSchema.parse(await c.req.json());
  return c.json(
    await c.env.runtime.authorized(c.req.raw.headers, (who) =>
      c.env.runtime.commerce.setQuantity(who, input),
    ),
  );
});
api.post("/checkout/quote", async (c) => {
  emptySchema.parse(await c.req.json());
  return c.json(
    await c.env.runtime.authorized(c.req.raw.headers, (who) =>
      c.env.runtime.commerce.prepareCheckout(who),
    ),
  );
});
api.post("/checkout/confirm", async (c) => {
  const input = confirmSchema.parse(await c.req.json());
  return c.json(
    await c.env.runtime.authorized(c.req.raw.headers, (who) =>
      c.env.runtime.commerce.confirmCheckout(who, input.quoteId),
    ),
  );
});

api.post("/mcp/conversations", async (c) => {
  emptySchema.parse(await c.req.json());
  const origin = new URL(c.req.url);
  // Default to the opposite loopback hostname on the sandbox port. A different port
  // alone would still share this origin's cookies with app code.
  const sandbox = new URL(
    c.env.sandboxOrigin ??
      `http://${origin.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${defaultSandboxPort}`,
  );
  if (
    !["http:", "https:"].includes(sandbox.protocol) ||
    sandbox.hostname === origin.hostname ||
    sandbox.username ||
    sandbox.password
  )
    throw new ApiError("The app sandbox requires a separate hostname without credentials.", 400);
  return c.json(
    await mcpClientFor(c.env.runtime).create(
      c.req.raw.headers,
      sandbox.origin,
      c.req.raw.signal,
      c.env.approvedRemote,
    ),
  );
});
api.delete("/mcp/conversations/:id", async (c) => {
  await mcpClientFor(c.env.runtime).remove(c.req.raw.headers, c.req.param("id"));
  return c.json({ ok: true });
});
// A model call has no viewId. A view call may use only that view's app tools.
api.on(
  "POST",
  ["/mcp/conversations/:id/call", "/mcp/conversations/:id/views/:viewId/call"],
  async (c) => {
    const input = hostCallSchema.parse(await c.req.json());
    return c.json(
      await mcpClientFor(c.env.runtime).call(
        c.req.raw.headers,
        c.req.param("id"),
        input.name,
        input.input,
        c.req.raw.signal,
        c.req.param("viewId"),
      ),
    );
  },
);
api.all("/generate", generate);

api.onError((error, c) => {
  if (error instanceof ApiError) {
    // SAFETY: server code throws ApiError only with 4xx and 5xx statuses, which all carry a body.
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  }
  if (error instanceof ZodError || error instanceof SyntaxError)
    return c.json({ error: "Invalid request data." }, 400);
  const gatewayRequest = ["/api/generate", "/api/models"].includes(c.req.path);
  return c.json(
    {
      error: gatewayRequest
        ? "Unable to reach AI Gateway. Try again shortly."
        : "Unable to complete the request.",
    },
    gatewayRequest ? 502 : 500,
  );
});
