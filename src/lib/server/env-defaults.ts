// Values used when a variable is empty or unset. .env.fx.example must match.
export const envDefaults = {
  FX_MODEL: "spacexai/grok-4.1-fast-non-reasoning",
  FX_DATABASE_PATH: "data/app.sqlite",
  FX_MCP_CLIENT_METADATA_URLS: "[]",
} as const;

// `task mcp-sandbox` listens here, and FX_MCP_SANDBOX_ORIGIN defaults to this port.
export const defaultSandboxPort = 5174;
