import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { z } from "zod";
import { readLimited } from "./http.ts";

const metadataSchema = z.object({
  jwks_uri: z.url().optional(),
  backchannel_logout_uri: z.never().optional(),
  sector_identifier_uri: z.never().optional(),
});
const nativeMetadataSchema = metadataSchema.extend({ jwks_uri: z.never().optional() });

// cimd streams the body without a size cap, so this is the only bound on metadata.
export async function boundedMetadata(incoming: Response) {
  if (incoming.status !== 200 || !incoming.body)
    throw new Error("MCP metadata must return HTTP 200 without redirects.");
  const reader = incoming.body.getReader();
  const body = await readLimited(reader, 64 * 1024);
  if (!body) {
    await reader.cancel();
    throw new Error("MCP metadata is too large.");
  }
  return new Response(body, {
    headers: { "content-type": "application/json", "cache-control": "max-age=60" },
  });
}

export function createClientMetadata(approvedUrls: readonly string[]) {
  const approved = new Set(
    approvedUrls.map((value) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new Error("MCP client metadata URLs must be explicit HTTPS URLs.");
      return url.href;
    }),
  );
  const cache = new Map<string, { expiresAt: number; response: Response }>();
  async function load(value: string) {
    const url = new URL(value);
    if (!approved.has(url.href)) throw new Error("MCP client metadata URL is not approved.");
    const cached = cache.get(url.href);
    if (cached && cached.expiresAt > Date.now()) return cached.response.clone();
    const response = await boundedMetadata(
      await fetchClientMetadataResource(url, { signal: AbortSignal.timeout(5000) }),
    );
    if (cache.size >= 16) cache.delete(cache.keys().next().value ?? "");
    cache.set(url.href, { expiresAt: Date.now() + 60_000, response: response.clone() });
    return response;
  }
  return {
    prepare: async (request: Request) => {
      const url = new URL(request.url);
      let clientId = url.searchParams.get("client_id");
      if (request.method === "POST") {
        const type = request.headers.get("content-type") ?? "";
        if (type.startsWith("application/x-www-form-urlencoded"))
          clientId = new URLSearchParams(await request.clone().text()).get("client_id");
        else if (type.startsWith("application/json")) {
          const body: unknown = await request
            .clone()
            .json()
            .catch(() => null);
          if (url.pathname === "/api/auth/oauth2/create-client") nativeMetadataSchema.parse(body);
          if (url.pathname === "/api/auth/oauth2/update-client")
            nativeMetadataSchema.parse(z.object({ update: z.unknown() }).parse(body).update);
          const parsed = z
            .object({
              client_id: z.string().optional(),
              oauth_query: z.string().optional(),
            })
            .safeParse(body);
          if (parsed.success)
            clientId =
              parsed.data.client_id ??
              new URLSearchParams(parsed.data.oauth_query ?? "").get("client_id") ??
              clientId;
        }
      }
      if (!clientId?.startsWith("https://")) return;
      const metadata = metadataSchema.parse(await (await load(clientId)).json());
      if (metadata.jwks_uri) await load(metadata.jwks_uri);
    },
    // Better Auth calls this while holding the shared database queue. Network I/O
    // belongs in prepare(), so a missing or expired cache entry fails instead of fetching.
    fetch: async (input: RequestInfo | URL) => {
      const value = input instanceof Request ? input.url : String(input);
      const cached = cache.get(new URL(value).href);
      if (!cached || cached.expiresAt <= Date.now())
        throw new Error("MCP metadata was not prepared outside the database queue.");
      return cached.response.clone();
    },
  };
}
