import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { getRequest, setResponse } from "@sveltejs/kit/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

type ResourceFault = "unavailable" | "missing" | "wrong-mime" | "oversized";

export async function chartFixture(port = 0) {
  const uri = "ui://chart/sales";
  let base = "http://127.0.0.1";
  let redirect: string | undefined;
  const paths: string[] = [];
  const headers: { authorization: string | undefined; cookie: string | undefined }[] = [];
  let filters = 0;
  let showCalls = 0;
  let resourceFault: ResourceFault | undefined;
  let endlessRead = false;
  let explanationPadding = 0;
  let streamedBytes = 0;
  let pending:
    | { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    | undefined;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "controlled-chart", version: "1.0.0" });
      registerAppTool(
        server,
        "show_chart",
        {
          description: "Show a sales chart.",
          inputSchema: z.strictObject({}),
          _meta: { ui: { resourceUri: uri, visibility: ["model", "app"] } },
        },
        async () => {
          showCalls++;
          return {
            content: [{ type: "text", text: "Sales chart is ready." }],
            structuredContent: { sales: [3, 8, 5] },
            _meta: { privateChartState: "chart-only" },
          };
        },
      );
      registerAppTool(
        server,
        "filter_chart",
        {
          description: "Filter the sales chart.",
          inputSchema: z.object({ period: z.enum(["week", "month"]) }),
          _meta: { ui: { resourceUri: uri, visibility: ["app"] } },
        },
        async ({ period }) => {
          filters++;
          const gate = pending;
          pending = undefined;
          if (gate) {
            gate.entered.resolve();
            await gate.release.promise;
          }
          return {
            content: [{ type: "text", text: "Chart filter updated." }],
            structuredContent: { period, sales: period === "week" ? [3, 8, 5] : [12, 32, 20] },
            _meta: { privateChartState: "filtered-chart-only" },
          };
        },
      );
      registerAppTool(
        server,
        "explain_chart",
        {
          description: "Explain the sales chart.",
          inputSchema: z.object({}),
          _meta: { ui: { visibility: ["model"] } },
        },
        async () => ({
          content: [
            {
              type: "text",
              text: "Sales peaked in the second period." + " ".repeat(explanationPadding),
            },
          ],
        }),
      );
      registerAppResource(server, "sales", uri, {}, async () => {
        const fault = resourceFault;
        resourceFault = undefined;
        if (fault === "unavailable") throw new Error("Fixture resource is unavailable.");
        return {
          contents:
            fault === "missing"
              ? []
              : [
                  {
                    uri,
                    mimeType: fault === "wrong-mime" ? "text/plain" : RESOURCE_MIME_TYPE,
                    text:
                      fault === "oversized"
                        ? "x".repeat(512_001)
                        : await readFile(
                            new URL("../../.outputs/mcp-test-fixtures/chart.html", import.meta.url),
                            "utf8",
                          ),
                  },
                ],
        };
      });
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "");
    if (redirect) {
      const location = redirect;
      redirect = undefined;
      response.writeHead(302, { location }).end();
      return;
    }
    headers.push({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (request.headers.authorization !== "Bearer fixture-chart-token") {
      response.writeHead(401).end();
      return;
    }
    try {
      const incoming = await getRequest({ request, base });
      if (endlessRead && (await incoming.clone().text()).includes('"resources/read"')) {
        endlessRead = false;
        response.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, " ");
        const pump = () => {
          while (!response.destroyed) {
            streamedBytes += chunk.length;
            if (!response.write(chunk)) break;
          }
          if (!response.destroyed) response.once("drain", pump);
        };
        pump();
        return;
      }
      await setResponse(response, await handler.fetch(incoming));
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Chart fixture did not listen.");
  base += ":" + address.port;
  return {
    url: base + "/mcp",
    paths,
    redirectNext(location: string) {
      redirect = location;
    },
    failNextResource(fault: ResourceFault) {
      resourceFault = fault;
    },
    padExplanations(bytes: number) {
      explanationPadding = bytes;
    },
    streamNextResourceForever() {
      endlessRead = true;
    },
    get streamedBytes() {
      return streamedBytes;
    },
    token: "fixture-chart-token",
    headers,
    get filters() {
      return filters;
    },
    get showCalls() {
      return showCalls;
    },
    blockNextFilter() {
      const gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      pending = gate;
      return gate;
    },
    async close() {
      pending?.release.resolve();
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await chartFixture(Number(process.argv[2] || 0));
  process.once("SIGTERM", () => {
    void fixture.close().then(() => process.exit(0));
  });
}
