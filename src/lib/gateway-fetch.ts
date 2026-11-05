import type { Account } from "./account.ts";
import { ApiError, streamedErrorSchema, conversationHeader } from "./contract.ts";

export function createGatewayFetch({
  account,
  reportError,
  onConversationLimit,
  conversationId,
}: {
  account: Account;
  reportError: (message: string) => void;
  onConversationLimit?: () => void;
  conversationId?: string;
}): typeof fetch {
  return async (input, init) => {
    try {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path =
        url.pathname === "/v4/ai/language-model" && request.method === "POST"
          ? "generate"
          : url.pathname === "/coding-agent/v1/models" && request.method === "GET"
            ? "models"
            : undefined;
      if (url.origin !== "https://ai-gateway.vercel.sh" || url.search || url.hash || !path)
        throw new Error("The fx SDK requested an unsupported model endpoint.");
      const headers = new Headers(request.headers);
      // The SDK requires a placeholder key; only the server adds a real credential.
      headers.delete("authorization");
      if (conversationId) headers.set(conversationHeader, conversationId);
      const response = await account.fetch(path, {
        method: path === "generate" ? "POST" : "GET",
        headers,
        body: path === "generate" ? await request.text() : undefined,
        signal: request.signal,
        failure: "Unable to reach the model. Try again.",
      });
      if (response.body) {
        // libfx drops streamed error details; observe our single-line SSE errors without buffering replies.
        const decoder = new TextDecoder();
        let pending = "";
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              pending += decoder.decode(chunk, { stream: true });
              const lines = pending.split("\n");
              pending = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const part = streamedErrorSchema.safeParse(JSON.parse(line.slice(6)));
                  if (part.success) reportError(part.data.error);
                } catch {}
              }
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    } catch (cause) {
      if (cause instanceof ApiError && cause.detail.code === "conversation_limit")
        onConversationLimit?.();
      reportError(cause instanceof Error ? cause.message : "The model connection failed.");
      throw cause;
    }
  };
}
