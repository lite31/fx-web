import { readFileSync } from "node:fs";
import type { UserConfig } from "vite";
import config from "../../vite.config.ts";

const fixture = "\0fx-chat-fixture";

export default {
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    {
      name: "fx-chat-fixture",
      enforce: "pre",
      resolveId: (id: string) => (id === "libfx/browser" ? fixture : null),
      load: (id: string) =>
        id === fixture ? readFileSync(new URL("./fx-browser.mjs", import.meta.url), "utf8") : null,
    },
  ],
} satisfies UserConfig;
