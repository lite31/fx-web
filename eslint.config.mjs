import tsParser from "@typescript-eslint/parser";
import { plugin as shadcn } from "@shadcn/lint";
import svelteParser from "svelte-eslint-parser";

export default [
  {
    files: ["src/routes/**/*.svelte", "src/lib/components/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tsParser },
    },
    plugins: { shadcn },
    rules: {
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-raw-colors": "error",
    },
  },
];
