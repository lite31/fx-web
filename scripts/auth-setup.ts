import { randomBytes } from "node:crypto";
import { readFile, open } from "node:fs/promises";

const path = ".env.fx";
const existing = await readFile(path, "utf8").catch((error: unknown) => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
  throw error;
});
// Preserve an existing signing key, including an exported assignment. Rotating
// it here would invalidate cookies whenever setup is rerun.
if (!/^\s*(?:export\s+)?BETTER_AUTH_SECRET\s*=/m.test(existing)) {
  const file = await open(path, "a", 0o600);
  try {
    // open() applies the mode only when it creates the file.
    await file.chmod(0o600);
    await file.write(
      `${existing && !existing.endsWith("\n") ? "\n" : ""}BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\n`,
    );
  } finally {
    await file.close();
  }
}
