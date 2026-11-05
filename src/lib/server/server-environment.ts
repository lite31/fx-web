import { env } from "$env/dynamic/private";
import type { RequestEvent } from "@sveltejs/kit";
import { createRuntime, type Runtime } from "./application-runtime.ts";
import { databasePath } from "./commerce.ts";
import { envDefaults } from "./env-defaults.ts";
import { api } from "./api.ts";
import { loopbackHosts } from "./http.ts";
import { isMcpProtocolPath, mcpHttp } from "./mcp-provider.ts";
import { z } from "zod";

let runtime: Promise<Runtime> | undefined;
function serverRuntime(origin: string) {
  return (runtime ??= createRuntime({
    path: databasePath(env.FX_DATABASE_PATH),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || origin,
    approvedClientMetadataUrls: z
      .array(z.url())
      .max(16)
      .parse(
        JSON.parse(env.FX_MCP_CLIENT_METADATA_URLS || envDefaults.FX_MCP_CLIENT_METADATA_URLS),
      ),
  }));
}
const serverConfig = () => ({
  gatewayKey: env.AI_GATEWAY_API_KEY,
  ...(env.FX_MCP_REMOTE_URL
    ? {
        approvedRemote: {
          url: env.FX_MCP_REMOTE_URL,
          ...(env.FX_MCP_REMOTE_TOKEN ? { token: env.FX_MCP_REMOTE_TOKEN } : {}),
        },
      }
    : {}),
  model: env.FX_MODEL || envDefaults.FX_MODEL,
  sandboxOrigin: env.FX_MCP_SANDBOX_ORIGIN || undefined,
});

// Check the host before the first request fixes the runtime's inferred auth origin.
// Rate limits trust x-real-ip, so replace any client-supplied value with the socket address.
export async function forward({ request, getClientAddress }: RequestEvent) {
  const url = new URL(request.url);
  if (!loopbackHosts.includes(url.hostname))
    return Response.json({ error: "Run this host locally." }, { status: 403 });
  const headers = new Headers(request.headers);
  headers.set("x-real-ip", getClientAddress());
  const incoming = new Request(request, { headers });
  const runtime = await serverRuntime(url.origin);
  return isMcpProtocolPath(url.pathname)
    ? mcpHttp.fetch(incoming, { runtime })
    : api.fetch(incoming, { runtime, ...serverConfig() });
}
