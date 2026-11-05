import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Environment } from "./api.ts";
import { mcpClientFor } from "./mcp-client.ts";
import {
  conversationHeader,
  conversationLimitError,
  shopTools,
  type HostedTool,
} from "../contract.ts";
import { z } from "zod";

const fieldsSchema = z.object({ prompt: z.unknown().optional(), tools: z.unknown().optional() });
function gatewaySchemas(catalog: readonly HostedTool[] = shopTools) {
  const toolNameSchema = z
    .string()
    .refine((name) => catalog.some((tool) => tool.name === name), "Unknown tool.");
  // The browser selects tool names, not their definitions. Rebuild descriptors
  // from the approved catalog so submitted descriptions and schemas cannot replace them.
  const toolsSchema = z
    .array(
      z.object({ type: z.literal("function"), name: z.string() }).transform((selection, ctx) => {
        const tool = catalog.find((known) => known.name === selection.name);
        if (!tool) {
          ctx.addIssue({ code: "custom", message: "Unknown shopping tool." });
          return z.NEVER;
        }
        return { type: selection.type, ...tool };
      }),
    )
    .max(catalog.length)
    .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length)
    .optional();

  // Gateway history carries opaque provider metadata that must survive replay.
  const textSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
  const reasoningSchema = z.looseObject({ type: z.literal("reasoning"), text: z.string() });
  const callFields = { toolName: toolNameSchema, toolCallId: z.string().min(1).max(128) };
  const toolCallSchema = z.looseObject({
    type: z.literal("tool-call"),
    ...callFields,
    input: z.looseObject({}),
  });
  const toolResultSchema = z.looseObject({
    type: z.literal("tool-result"),
    ...callFields,
    output: z.discriminatedUnion("type", [
      z.looseObject({ type: z.literal("text"), value: z.string() }),
      z.looseObject({ type: z.literal("error-text"), value: z.string() }),
      z.looseObject({ type: z.literal("execution-denied"), reason: z.string() }),
    ]),
  });
  const promptSchema = z
    .array(
      z.discriminatedUnion("role", [
        z.looseObject({
          role: z.literal("system"),
          content: z.union([z.string(), z.array(textSchema)]),
        }),
        z.looseObject({ role: z.literal("user"), content: z.array(textSchema) }),
        z.looseObject({
          role: z.literal("assistant"),
          content: z.array(
            z.discriminatedUnion("type", [textSchema, reasoningSchema, toolCallSchema]),
          ),
        }),
        z.looseObject({ role: z.literal("tool"), content: z.array(toolResultSchema) }),
      ]),
    )
    .min(1)
    .max(40);
  return { toolsSchema, promptSchema };
}
const gatewayErrorSchema = z.object({ error: z.object({ type: z.string() }) });

async function gatewayFailure(upstream: Response) {
  const detail = gatewayErrorSchema.safeParse(await upstream.json().catch(() => null));
  if (detail.success && detail.data.error.type === "customer_verification_required") {
    return "AI Gateway requires a card on file. Complete verification in the Vercel dashboard.";
  }
  return upstream.status === 429
    ? "Gateway rate limit reached. Try again shortly."
    : "Gateway could not respond. Check the server key and selected model.";
}

export async function models(c: Context<Environment>) {
  await c.env.runtime.authorized(c.req.raw.headers, () => true);
  if (!c.env.gatewayKey)
    return c.json({ error: "Set AI_GATEWAY_API_KEY in the server environment." }, 503);
  const upstream = await fetch("https://ai-gateway.vercel.sh/coding-agent/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${c.env.gatewayKey}` },
    redirect: "error",
    signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]),
  });
  if (!upstream.ok) return c.json({ error: await gatewayFailure(upstream) }, 502);
  return new Response(upstream.body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function generate(c: Context<Environment>) {
  if (c.req.method !== "POST") return c.json({ error: "Method not allowed." }, 405);
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: "Send valid JSON." }, 400);
  }
  const conversationId = c.req.header(conversationHeader);
  const catalog =
    conversationId === undefined
      ? undefined
      : await mcpClientFor(c.env.runtime).catalog(c.req.raw.headers, conversationId);
  const { toolsSchema, promptSchema } = gatewaySchemas(catalog);
  const fields = fieldsSchema.safeParse(input);
  const tools = toolsSchema.safeParse(fields.success ? fields.data.tools : undefined);
  if (!tools.success) return c.json({ error: "Use only the supported shopping tools." }, 400);
  const prompt = promptSchema.safeParse(fields.success ? fields.data.prompt : undefined);
  if (!prompt.success) {
    // Only too many messages means the conversation hit its limit. Other mismatches are protocol errors.
    if (prompt.error.issues.every((issue) => issue.code === "too_big" && !issue.path.length))
      return c.json(conversationLimitError, 400);
    return c.json({ error: "Send a supported conversation of 1–40 messages." }, 400);
  }
  const body = JSON.stringify({
    prompt: prompt.data,
    maxOutputTokens: 1024,
    ...(tools.data?.length ? { tools: tools.data } : {}),
  });

  await c.env.runtime.authorized(c.req.raw.headers, () => true);

  if (!c.env.gatewayKey)
    return c.json({ error: "Set AI_GATEWAY_API_KEY in the server environment." }, 503);

  const headers = new Headers({
    Authorization: `Bearer ${c.env.gatewayKey}`,
    "Content-Type": "application/json",
  });
  headers.set("ai-language-model-id", c.env.model);
  headers.set("ai-language-model-streaming", "true");
  for (const name of ["ai-gateway-protocol-version", "ai-language-model-specification-version"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }

  const abort = new AbortController();
  const forward = () =>
    fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.any([abort.signal, c.req.raw.signal, AbortSignal.timeout(90_000)]),
    });

  // Return SSE before waiting for Gateway headers so response cancellation can
  // abort the upstream fetch even after Node has finished reading the POST body.
  const response = streamSSE(c, async (output) => {
    output.onAbort(() => abort.abort());
    try {
      const upstream = await forward();
      if (!upstream.ok) {
        const error = await gatewayFailure(upstream);
        await output.writeSSE({ data: JSON.stringify({ type: "error", error }) });
      } else if (upstream.body) {
        await output.pipe(upstream.body);
      }
    } catch {
      if (!output.aborted) {
        // End any incomplete upstream event before sending our error frame.
        await output.write("\n\n");
        await output.writeSSE({
          data: JSON.stringify({
            type: "error",
            error: "Unable to reach AI Gateway. Try again shortly.",
          }),
        });
      }
    }
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
