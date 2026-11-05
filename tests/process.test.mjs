import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, startTask, waitForReady } from "./fixtures/process.mjs";

async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "fx-process-"));
  let child;
  t.after(async () => {
    try {
      await child?.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await writeFile(join(directory, "fixture.mjs"), source);
  await writeFile(
    join(directory, "Taskfile.yaml"),
    JSON.stringify({
      version: "3",
      tasks: { run: { cmds: ["{{.NODE | shellQuote}} fixture.mjs"] } },
    }),
  );
  child = startTask(["run", `NODE=${process.execPath}`], { cwd: directory });
  return child;
}

test("fixture readiness reports an early Task failure with its diagnostics", async (t) => {
  const child = await fixture(t, "console.error('fixture startup failed'); process.exitCode = 7;");
  await assert.rejects(
    waitForReady([child], async () => false),
    /fixture startup failed/,
  );
});

test("fixture readiness reports a missing Task executable and cleanup remains safe", async () => {
  const child = startTask([], { env: { PATH: "" } });
  try {
    await assert.rejects(
      waitForReady([child], async () => false),
      /Unable to start task/,
    );
  } finally {
    await child.stop();
    await child.stop();
  }
});

test("fixture startup reports an occupied port without stopping its existing owner", async (t) => {
  const owner = createServer();
  owner.listen(0, "127.0.0.1");
  await once(owner, "listening");
  t.after(() => new Promise((resolve) => owner.close(resolve)));
  const port = owner.address().port;
  const child = await fixture(
    t,
    `import {createServer} from 'node:net'; createServer().listen(${port}, '127.0.0.1');`,
  );
  await assert.rejects(
    waitForReady([child], async () => false),
    /EADDRINUSE/,
  );
  assert.ok(owner.listening);
});

test("fixture cleanup survives a denied existence probe, stops a TERM-resistant server and can be repeated", async (t) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = await fixture(
    t,
    `
    import {createServer} from 'node:http';
    process.on('SIGTERM', () => {});
    createServer((_, response) => response.end('fixture ready')).listen(${port}, '127.0.0.1');
  `,
  );
  await waitForReady([child], async (signal) => (await fetch(origin, { signal })).ok);
  assert.equal(await (await fetch(origin)).text(), "fixture ready");
  const kill = process.kill;
  let deniedProbe = false;
  let group;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid < 0) group = pid;
    if (pid < 0 && signal === 0 && !deniedProbe) {
      deniedProbe = true;
      throw Object.assign(new Error("Fixture process-group probe denied"), { code: "EPERM" });
    }
    return kill.call(process, pid, signal);
  });
  let failure;
  try {
    await child.stop();
    await child.stop();
  } catch (error) {
    failure = error;
  }
  t.mock.restoreAll();
  if (failure) {
    if (group !== undefined) {
      try {
        kill.call(process, group, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH")
          throw new AggregateError([failure, error], "Fixture cleanup failed.");
      }
    }
    throw failure;
  }
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1000) }));
});
