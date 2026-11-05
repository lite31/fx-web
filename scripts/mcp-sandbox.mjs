import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { defaultSandboxPort } from "../src/lib/server/env-defaults.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: String(defaultSandboxPort) },
    "host-origin": {
      type: "string",
      multiple: true,
      default: ["http://localhost:5173", "http://127.0.0.1:5173"],
    },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid sandbox port.");
const origins = values["host-origin"].map((value) => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
    throw new Error("Expected a host origin.");
  return url.origin;
});
const html = (await readFile(new URL("./mcp-sandbox.html", import.meta.url), "utf8")).replace(
  "__FX_HOST_ORIGINS__",
  JSON.stringify(origins).replaceAll("<", "\\u003c"),
);
// This fixed CSP is inherited by the inner srcdoc frame. App resource metadata
// cannot expand it, so apps must bundle their code and use the tool bridge for data.
const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  `frame-ancestors ${origins.join(" ")}`,
].join("; ");
const server = createServer((request, response) => {
  const host = request.headers.host;
  if (
    ![`localhost:${port}`, `127.0.0.1:${port}`].includes(host) ||
    // Ports do not isolate cookies. The app must use the opposite loopback hostname,
    // and this proxy refuses cookie-bearing requests even from an allowed host.
    request.headers.cookie ||
    request.method !== "GET" ||
    request.url !== "/mcp-sandbox.html"
  ) {
    response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": policy,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-write=()",
  });
  response.end(html);
});
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`MCP sandbox listening on 127.0.0.1:${port}\n`),
);
