---
name: verify-fx-web
description: Verify fx-web's shopping and account UI, browser `fx` chat, WebMCP tools, and MCP Apps using isolated local instances and the existing Task/browser tests. Use after behavior changes or to reproduce a user journey with saved evidence.
---

# Verify fx-web

Read [the feature map](features/README.md), then the relevant journey. Work from
the fx-web project directory. Use Task for orchestration. The main
surface is the SvelteKit web UI. WebMCP and the OAuth-protected `/mcp` provider
are separate agent entry points.

## Launch

Install the [project prerequisites](../../../README.md#prepare-the-environment)
and make `lsof` and `ps` available. Run `task install` if packages are missing,
then `task browser-install` to install Chromium for the pinned local CLI.
Read the installed browser guide through Task before driving it:

```bash
task browser -- skills get core
```

Allocate a new run and seed three products into its empty database:

```bash
export FX_VERIFY_TASK=.cursor/skills/verify-fx-web/Taskfile.yaml
export FX_VERIFY_RUN="$(task -t "$FX_VERIFY_TASK" new)"
task -t "$FX_VERIFY_TASK" prepare
```

Keep both exports in every terminal used for this run. `prepare` imports Coffee
at €5, Plant at €18, and Book at €24, with ten units each. It refuses to overwrite
an existing database. Launch in a dedicated foreground terminal:

```bash
task -t "$FX_VERIFY_TASK" launch > "${FX_VERIFY_RUN}.evidence/server.log" 2>&1
```

Keep the terminal or tool session handle. Do not detach the launcher. Vite's
`Local` line identifies the allocated origin. `--strictPort` refuses a collision;
start a new run if another process takes the allocated port.

The helper uses Vite's documented CLI under Task and explicitly overrides the
database, auth secret, model, and MCP configuration with `env`. It bypasses
the application's dotenv loader, supplies no Gateway key, and never changes
`.env.fx`. Empty Task `env` entries alone do not clear inherited credentials.
Better Auth
creates its tables when the server initializes. Open the app from another
terminal, then follow [account access](features/accounts.md):

```bash
task -t "$FX_VERIFY_TASK" doctor > "${FX_VERIFY_RUN}.evidence/doctor.json"
task -t "$FX_VERIFY_TASK" browser -- open "$(task -t "$FX_VERIFY_TASK" origin)"
task -t "$FX_VERIFY_TASK" browser -- snapshot -i
```

Ready means the account form works and, after creating the disposable account,
all three seeded products and an empty cart appear. A listening port alone is
insufficient. Without a Gateway key the chat reports a configuration error;
account, shopping, and WebMCP verification remain usable. For chat and MCP Apps,
use the existing fixture-driven browser tests described in their feature files.

## Doctor

Run `task -t "$FX_VERIFY_TASK" doctor` before driving and whenever the page looks
wrong. It makes read-only checks of the launcher, listener ancestry, unique
model marker, disabled Gateway access, and the sign-in page. It fails if the
port belongs to another process or the response comes from another instance.
After signing in, inspect the account name and cart in a browser snapshot too.
Do not use a failed doctor result as permission to drive a shared instance.

## Drive

Use `task -t "$FX_VERIFY_TASK" browser -- ...` for this run's named browser.
It forwards to fx-web's existing `browser` task. Use accessible names or the
selectors in the feature map. Snapshot again after navigation. Browser `eval`
may read the rendered page or call its published WebMCP interface. Do not use
internal setters, fixture globals, or injected controls as proof of a UI path.

Run the existing `task test-browser` once for both chat and MCP Apps and retain
`${FX_VERIFY_RUN}.evidence/browser-tests.log`. Reuse that log across their feature
checks rather than running the same suite twice. It runs separate, disposable chat
and MCP Apps journeys. Its controlled `fx` implementation replaces the external
model, not Better Auth, SQLite, MCP transports, or AppBridge. Label that evidence
as fixture-driven; it does not prove live-model selection or compatibility with
Codex/ChatGPT.

Run manual journeys and test suites serially in one checkout. Before `task test`
or `task test-browser`, stop this run's launcher with Ctrl+C. They share
`.svelte-kit/` and bundle outputs with the manual instance and can reload its page,
even though databases, ports, and browsers differ. After the suites finish,
launch again with the same `FX_VERIFY_RUN`, run doctor, and reopen a known page
before continuing. Do not run `prepare` again or stop another user's server.

## Evidence

Store evidence in `${FX_VERIFY_RUN}.evidence`, outside the removable run directory.
Capture the action and resulting state. Include the feature ID and entry point
in an `actions.txt` transcript. Save snapshots before and after, a screenshot,
the doctor result, and a second read of persistent state:

```bash
task -t "$FX_VERIFY_TASK" browser -- snapshot -i > "${FX_VERIFY_RUN}.evidence/after.txt"
task -t "$FX_VERIFY_TASK" browser -- screenshot "${FX_VERIFY_RUN}.evidence/after.png"
task -t "$FX_VERIFY_TASK" state > "${FX_VERIFY_RUN}.evidence/state.json"
```

`state` opens only this run's database read-only and reports cart quantities,
revisions, product prices/stock, and order IDs. It never reads session tokens.
Reload the UI to prove persistence as well. For checkout, compare order IDs and
stock before/after confirmation. Never confirm orders against a user's database.
Keep credentials, cookies, OAuth tokens, and unsanitized network traces out of
evidence. Report missing preconditions as failures, not alternate-path passes.

## Cleanup

Stop the dedicated launch terminal with Ctrl+C. With a tool-managed terminal,
send Ctrl+C to the recorded session and wait for exit. Never kill by process
name, stop an existing development server, or delete its database. Then run:

```bash
task -t "$FX_VERIFY_TASK" cleanup
```

Cleanup refuses a live launcher or listening port, closes only the run's browser
session, and removes the marked run directory. If it refuses, keep the directory
and inspect the owner recorded by doctor. Stop only processes this run created.
Run cleanup after failed attempts too. Confirm the screenshot, state file, and
action transcript still exist in `${FX_VERIFY_RUN}.evidence` after cleanup.

## Helpers

[Taskfile.yaml](Taskfile.yaml) provides `new`, `prepare`, `launch`, `origin`,
`doctor`, `browser`, `state`, and `cleanup`. Their invocations are shown above.
It adds no application endpoints or runtime dependencies.

Keep the feature map current with `/maintain-verification-skill`.
