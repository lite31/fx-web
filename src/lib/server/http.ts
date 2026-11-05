import type { MiddlewareHandler } from "hono";
import { chatBodyLimit, conversationLimitError } from "../contract.ts";

export const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];

// Mutations must send this origin's Origin header. Reads may omit it, but never come cross-site.
export const localRequests: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  if (!loopbackHosts.includes(url.hostname)) {
    return c.json({ error: "Run this host locally." }, 403);
  }
  const origin = c.req.header("origin");
  if (
    (origin && origin !== url.origin) ||
    (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && origin !== url.origin) ||
    c.req.header("sec-fetch-site") === "cross-site"
  ) {
    return c.json({ error: "Use this host's own interface." }, 403);
  }
  c.header("Cache-Control", "no-store");
  await next();
};

// Returns null after the first chunk past the limit. The caller cancels or releases the reader.
export async function readLimited(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > limit) return null;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

export const limitRequestBody: MiddlewareHandler = async (c, next) => {
  if (c.req.raw.body) {
    const reader = c.req.raw.body.getReader();
    const body = await readLimited(reader, c.req.path === "/api/chat" ? chatBodyLimit : 64 * 1024);
    if (!body) {
      // Cancelling SvelteKit's request stream destroys the socket before the error can be sent.
      reader.releaseLock();
      c.header("Connection", "close");
      return c.json(
        c.req.path === "/api/generate" ? conversationLimitError : { error: "Request too large." },
        413,
      );
    }
    // Count the bytes actually sent rather than trusting Content-Length, then give
    // handlers a fresh request because the original body stream is now consumed.
    c.req.raw = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body,
      signal: c.req.raw.signal,
    });
  }
  await next();
};

export const requireJson: MiddlewareHandler = async (c, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !c.req.header("content-type")?.startsWith("application/json")
  )
    return c.json({ error: "Send JSON." }, 400);
  await next();
};
