import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig(({ mode }) => {
  const fixture = mode === "chart-fixture";
  return {
    root: resolve(fixture ? "tests/fixtures/chart-ui" : "src/mcp-ui"),
    plugins: [
      svelte({ compilerOptions: { runes: true } }),
      {
        name: "portable-mcp-app",
        enforce: "post",
        // MCP serves HTML as a resource, not a website with adjacent assets.
        // Inline the single script and CSS so the fixed sandbox needs no network access.
        generateBundle(_options, bundle) {
          const html = Object.values(bundle).find(
            (item) => item.type === "asset" && item.fileName.endsWith(".html"),
          );
          if (!html || html.type !== "asset") throw new Error("App HTML was not emitted.");
          const scripts = Object.values(bundle).filter((item) => item.type === "chunk");
          if (scripts.length !== 1) throw new Error("App must have one portable script.");
          const css = Object.values(bundle)
            .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
            .map((item) => (item.type === "asset" ? String(item.source) : ""))
            .join("\n");
          // Write `<\/script` so bundled code cannot end the inline script early. 92 is a backslash.
          const code = scripts[0].code.replace(
            new RegExp("</script", "gi"),
            "<" + String.fromCharCode(92) + "/script",
          );
          const document = String(html.source)
            .replace(/<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/g, "")
            .replace(/<link\b[^>]*\b(?:rel="stylesheet"|rel="modulepreload")[^>]*>/g, "")
            // Callbacks preserve dollar sequences inside bundled SDK code and CSS.
            .replace("</head>", () => "<style>" + css + "</style></head>")
            .replace("</body>", () => '<script type="module">' + code + "</script></body>");
          for (const name of Object.keys(bundle)) delete bundle[name];
          this.emitFile({
            type: "asset",
            fileName: fixture ? "chart.html" : "shop.html",
            source: document,
          });
        },
      },
    ],
    build: {
      outDir: resolve(fixture ? ".outputs/mcp-test-fixtures" : ".outputs/mcp-shop"),
      emptyOutDir: true,
      cssCodeSplit: false,
      rolldownOptions: { output: { codeSplitting: false } },
    },
  };
});
