import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CallToolResultSchema, ToolSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import {
  ApiError,
  hostedToolSchema,
  hostInvocationSchema,
  hostViewSchema,
  type HostedTool,
  type HostConversation,
  type HostInvocation,
  type HostView,
  shopTools,
} from "../contract.ts";
import type { Runtime } from "./application-runtime.ts";
import type { Identity } from "./commerce.ts";
import { createShopMcpHandler } from "./mcp-provider.ts";

const lifetime = 30 * 60_000;
const maxConversations = 64;
const maxCalls = 32;
const maxBytes = 8 * 1024 * 1024;
const uiSchema = z.object({
  resourceUri: z.string().max(2048).optional(),
  visibility: z.array(z.enum(["model", "app"])).optional(),
});
type CallToolResult = z.infer<typeof CallToolResultSchema>;
type Tool = z.infer<typeof ToolSchema>;
export type ApprovedRemote = { url: string; token?: string };
type Connection = {
  client: Client;
  url: URL;
} & (
  | { name: "shop"; handler: ReturnType<typeof createShopMcpHandler> }
  | { name: "remote"; token?: string }
);
type CatalogTool = {
  connection: Connection;
  definition: HostedTool;
  remoteName: string;
  model: boolean;
  app: boolean;
  uri?: string;
};
type Conversation = {
  id: string;
  owner: Identity;
  expiresAt: number;
  connections: Connection[];
  abort: AbortController;
  tools: Map<string, CatalogTool>;
  views: Map<string, Connection>;
  calls: number;
  bytes: number;
};

function reset(): never {
  throw new ApiError("This app conversation expired. Start a new conversation to continue.", 409, {
    code: "conversation_limit",
  });
}
function sameOwner(left: Identity, right: Identity) {
  return left.userId === right.userId && left.sessionId === right.sessionId;
}
function catalogTool(tool: Tool, connection: Connection): CatalogTool {
  const metadata = uiSchema.safeParse(tool._meta?.ui);
  if (tool._meta?.ui !== undefined && !metadata.success)
    throw new ApiError("The app advertised an unsupported UI policy.", 502);
  const ui = metadata.success ? metadata.data : undefined;
  const visibility = ui?.visibility ?? ["model", "app"];
  return {
    connection,
    definition: hostedToolSchema.parse({
      name: connection.name + "__" + tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema,
    }),
    remoteName: tool.name,
    model: visibility.includes("model"),
    app: visibility.includes("app"),
    ...(ui?.resourceUri ? { uri: ui.resourceUri } : {}),
  };
}

function approvedRemoteUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ApiError(
      "Approved remote apps require a fixed HTTP loopback URL with an explicit port and no credentials, query or fragment.",
      400,
    );
  url.hostname = "127.0.0.1";
  return url;
}
function boundedResponse(response: Response) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          bytes += next.value.byteLength;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            controller.error(new Error("App response exceeds host limit."));
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

// This is the backend MCP client used by fx-web's chat host. The shop connection
// uses an in-process provider handler. Only an explicitly approved remote uses HTTP.
function createMcpHost(runtime: Runtime) {
  const conversations = new Map<string, Conversation>();
  function dispose(conversation: Conversation) {
    conversations.delete(conversation.id);
    conversation.abort.abort();
    conversation.views.clear();
    return Promise.allSettled(
      conversation.connections.flatMap((connection) => [
        connection.client.close(),
        ...(connection.name === "shop" ? [connection.handler.close()] : []),
      ]),
    );
  }
  runtime.onSessionEnd((owner) => {
    for (const conversation of conversations.values()) {
      if (!owner || sameOwner(owner, conversation.owner)) void dispose(conversation);
    }
  });
  function prune() {
    for (const conversation of conversations.values()) {
      if (conversation.expiresAt <= Date.now()) void dispose(conversation);
    }
  }
  function owned(owner: Identity, id: string) {
    prune();
    const conversation = conversations.get(id);
    if (!conversation || !sameOwner(owner, conversation.owner)) reset();
    return conversation;
  }
  async function recheck(headers: Headers, conversation: Conversation) {
    await runtime.authorized(headers, (owner) => {
      if (owned(owner, conversation.id) !== conversation) reset();
      return true;
    });
  }
  async function create(
    headers: Headers,
    viewOrigin: string,
    signal?: AbortSignal,
    approvedRemote?: ApprovedRemote,
  ): Promise<HostConversation> {
    const conversation = await runtime.authorized(headers, (owner) => {
      prune();
      if (
        conversations.size >= maxConversations ||
        [...conversations.values()].filter((item) => sameOwner(owner, item.owner)).length >= 4
      )
        reset();
      const client = () =>
        new Client(
          { name: "fx-web-host", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
      const remoteUrl = approvedRemote ? approvedRemoteUrl(approvedRemote.url) : undefined;
      const connections: Connection[] = [
        {
          name: "shop",
          client: client(),
          url: new URL(runtime.resource),
          handler: createShopMcpHandler(runtime, owner),
        },
      ];
      if (approvedRemote && remoteUrl)
        connections.push({
          name: "remote",
          client: client(),
          url: remoteUrl,
          ...(approvedRemote.token ? { token: approvedRemote.token } : {}),
        });
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        owner,
        connections,
        expiresAt: Date.now() + lifetime,
        abort: new AbortController(),
        tools: new Map(),
        views: new Map(),
        calls: 0,
        bytes: 0,
      };
      conversations.set(conversation.id, conversation);
      return conversation;
    });
    const requestSignal = AbortSignal.any([
      conversation.abort.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    try {
      const tools: CatalogTool[] = [];
      for (const connection of conversation.connections) {
        const transport = new StreamableHTTPClientTransport(connection.url, {
          fetch: async (input, init) => {
            const request = new Request(input, {
              ...init,
              credentials: "omit",
              redirect: "error",
              signal: AbortSignal.any([
                conversation.abort.signal,
                ...(init?.signal ? [init.signal] : []),
                AbortSignal.timeout(30_000),
              ]),
            });
            if (request.url !== connection.url.href)
              throw new ApiError("The app requested an unapproved endpoint.", 502);
            if (connection.name === "shop") return connection.handler.fetch(request);
            request.headers.delete("cookie");
            request.headers.delete("authorization");
            if (connection.token)
              request.headers.set("authorization", "Bearer " + connection.token);
            return boundedResponse(await fetch(request));
          },
        });
        await connection.client.connect(transport, { signal: requestSignal });
        const listed = await connection.client.listTools(undefined, { signal: requestSignal });
        const resources = await connection.client.listResources(undefined, {
          signal: requestSignal,
        });
        if (listed.nextCursor || resources.nextCursor || tools.length + listed.tools.length > 32)
          throw new ApiError("The app catalog exceeds this host's limit.", 502);
        const approvedUris = new Set(resources.resources.map((resource) => resource.uri));
        for (const listedTool of listed.tools) {
          const tool = catalogTool(listedTool, connection);
          if (tool.uri && !approvedUris.has(tool.uri))
            throw new ApiError("The app resource is unavailable.", 502);
          tools.push(tool);
        }
      }
      await recheck(headers, conversation);
      if (requestSignal.aborted) throw requestSignal.reason;
      for (const tool of tools) conversation.tools.set(tool.definition.name, tool);
      return {
        id: conversation.id,
        tools: tools
          .values()
          .filter((tool) => tool.model)
          .map((tool) => tool.definition)
          .toArray(),
        sandboxOrigin: viewOrigin,
      };
    } catch (error) {
      await dispose(conversation);
      throw error;
    }
  }
  async function catalog(headers: Headers, id: string) {
    return runtime.authorized(headers, (owner) => {
      const conversation = owned(owner, id);
      if (!conversation.tools.size) reset();
      return [
        ...shopTools,
        ...conversation.tools
          .values()
          .filter((tool) => tool.model)
          .map((tool) => tool.definition),
      ];
    });
  }
  async function call(
    headers: Headers,
    id: string,
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    viewId?: string,
  ): Promise<HostInvocation | CallToolResult> {
    const { conversation, tool } = await runtime.authorized(headers, (owner) => {
      const conversation = owned(owner, id);
      // A view grants access only to app-visible tools on its own connection.
      // Model calls use the separate model-visible catalog and namespaced tool names.
      const connection = viewId ? conversation.views.get(viewId) : undefined;
      if (viewId && !connection) throw new ApiError("This app view is unavailable.", 403);
      const tool = viewId
        ? [...conversation.tools.values()].find(
            (item) => item.connection === connection && item.remoteName === name && item.app,
          )
        : conversation.tools.get(name);
      if (!tool || (viewId ? !tool.app : !tool.model))
        throw new ApiError("This tool is unavailable to this app.", 403);
      if (conversation.calls >= maxCalls) reset();
      conversation.calls++;
      return { conversation, tool };
    });
    const requestSignal = AbortSignal.any([
      conversation.abort.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    const raw = CallToolResultSchema.parse(
      await tool.connection.client.callTool(
        { name: tool.remoteName, arguments: input },
        { signal: requestSignal },
      ),
    );
    const resultId = crypto.randomUUID();
    // The session or conversation may have ended during the tool call. Recheck
    // ownership before retaining its result or exposing a new interactive view.
    const bytes = Buffer.byteLength(JSON.stringify(raw));
    await runtime.authorized(headers, (owner) => {
      if (owned(owner, id) !== conversation || requestSignal.aborted) reset();
      if (bytes > 1024 * 1024 || conversation.bytes + bytes > maxBytes) reset();
      conversation.bytes += bytes;
      return true;
    });
    if (viewId) return raw;
    let view: HostView | undefined;
    if (tool.uri) {
      try {
        const resource = await tool.connection.client.readResource(
          { uri: tool.uri },
          { signal: requestSignal },
        );
        const html = resource.contents.find(
          (part) =>
            part.uri === tool.uri &&
            "text" in part &&
            part.mimeType === "text/html;profile=mcp-app",
        );
        if (html && "text" in html) {
          view = hostViewSchema.parse({
            id: resultId,
            title:
              tool.connection.name === "shop" ? "Shop" : tool.definition.description.slice(0, 200),
            html: html.text,
            input,
            result: raw,
          });
        }
      } catch {
        if (requestSignal.aborted) throw requestSignal.reason;
      }
    }
    // fx receives text only. Structured results and UI metadata go to the view,
    // which keeps HTML and app transport details out of the model-facing result.
    const text = (
      (tool.uri && !view ? "The app view could not be displayed.\n\n" : "") +
      raw.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    ).slice(0, 16_000);
    const invocation = hostInvocationSchema.parse({ text, ...(view ? { view } : {}) });
    await runtime.authorized(headers, (owner) => {
      if (owned(owner, id) !== conversation || requestSignal.aborted) reset();
      const viewBytes = view ? Buffer.byteLength(view.html) : 0;
      if (conversation.bytes + viewBytes > maxBytes) reset();
      conversation.bytes += viewBytes;
      if (view) conversation.views.set(view.id, tool.connection);
      return true;
    });
    return invocation;
  }
  async function remove(headers: Headers, id: string) {
    const conversation = await runtime.authorized(headers, (owner) => owned(owner, id));
    await dispose(conversation);
  }
  return { create, catalog, call, remove };
}
const hosts = new WeakMap<Runtime, ReturnType<typeof createMcpHost>>();
export function mcpClientFor(runtime: Runtime) {
  let host = hosts.get(runtime);
  if (!host) {
    host = createMcpHost(runtime);
    hosts.set(runtime, host);
  }
  return host;
}
