import type { z } from "zod";
import { ApiError, authErrorSchema, errorSchema, expectedUserHeader } from "./contract.ts";

/**
 * The account this tab believes is signed in, bound to how long that belief holds.
 * `signal` aborts when the owner clears identity or closes; every call made through
 * this Account then rejects with an AbortError instead of a stale result.
 */
export type Account = {
  readonly userId: string | undefined;
  readonly signal: AbortSignal;
  /** Same-origin request to `/api/${path}`. Resolves only for ok responses. */
  fetch(path: string, init?: AccountRequest): Promise<Response>;
  /** `fetch`, then parse the JSON body with `schema`. */
  json<T>(path: string, schema: z.ZodType<T>, init?: AccountRequest): Promise<T>;
  /** Same account and 401 policy, with a lifetime that also ends when `signal` aborts. */
  within(signal: AbortSignal): Account;
};

export type AccountRequest = {
  /** Defaults to GET, or POST when `json` or `body` is set. */
  method?: "GET" | "POST" | "DELETE";
  json?: unknown;
  body?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** Sent after a lifetime ends (a DELETE on close): skips the account signal and the 401 callback. */
  keepalive?: boolean;
  /** Message when the error body does not match the wire error schema. */
  failure?: string;
};

export function createAccount({
  userId,
  signal,
  onUnauthorized,
}: {
  userId: string | undefined;
  signal: AbortSignal;
  /** Called once per 401 while this account is live, with the request path (e.g. "auth/get-session"). Keepalive requests never call it. */
  onUnauthorized: (path: string) => void;
}): Account {
  async function send(path: string, init: AccountRequest = {}) {
    const linked = init.keepalive
      ? init.signal
      : AbortSignal.any(init.signal ? [signal, init.signal] : [signal]);
    linked?.throwIfAborted();
    const headers = new Headers(init.headers);
    if (userId) headers.set(expectedUserHeader, userId);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const response = await fetch(`/api/${path}`, {
      method: init.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      credentials: "same-origin",
      keepalive: init.keepalive,
      signal: linked,
    });
    if (response.ok) return { response, linked };
    const data: unknown = await response.json().catch(() => null);
    // A stale account must not report its 401, and a caller's own cancel must not hide one.
    // The 401 policy may end this account itself, so only the caller's signal is checked after it.
    if (!init.keepalive) signal.throwIfAborted();
    if (response.status === 401 && !init.keepalive) onUnauthorized(path);
    init.signal?.throwIfAborted();
    // Only better-auth routes answer with its `{ message }` error shape.
    const failure = (
      path.startsWith("auth/") ? errorSchema.or(authErrorSchema) : errorSchema
    ).safeParse(data);
    if (!failure.success) throw new ApiError(init.failure ?? "Request failed.", response.status);
    const { error, ...detail } = failure.data;
    throw new ApiError(error, response.status, detail);
  }
  return {
    userId,
    signal,
    fetch: async (path, init) => (await send(path, init)).response,
    async json(path, schema, init) {
      const { response, linked } = await send(path, init);
      const data: unknown = await response.json();
      linked?.throwIfAborted();
      return schema.parse(data);
    },
    within: (child) =>
      createAccount({ userId, signal: AbortSignal.any([signal, child]), onUnauthorized }),
  };
}
