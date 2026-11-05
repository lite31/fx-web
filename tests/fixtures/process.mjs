import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export function startTask(
  args,
  { cwd = new URL("../../", import.meta.url), env = process.env } = {},
) {
  const child = spawn("task", args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError;
  let stopping;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-6000);
    });

  function groupExists() {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
      throw error;
    }
  }

  function signalGroup(signal) {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  async function waitForGroup() {
    const deadline = Date.now() + 2000;
    while (groupExists() && Date.now() < deadline) await delay(25);
    return !groupExists();
  }

  return {
    get output() {
      return output;
    },
    assertRunning() {
      if (spawnError)
        throw new Error(`Unable to start task ${args.join(" ")}`, { cause: spawnError });
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Task ${args.join(" ")} exited before readiness (${child.signalCode ?? child.exitCode}).\n${output}`,
        );
    },
    stop() {
      stopping ??= (async () => {
        signalGroup("SIGTERM");
        if (await waitForGroup()) return;
        signalGroup("SIGKILL");
        if (!(await waitForGroup()))
          throw new Error(`Task ${args.join(" ")} process group did not stop.\n${output}`);
      })();
      return stopping;
    },
  };
}

export async function waitForReady(children, probe) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    for (const child of children) child.assertRunning();
    let ready = false;
    try {
      ready = await probe(AbortSignal.timeout(Math.min(1000, deadline - Date.now())));
    } catch (error) {
      lastError = error;
    }
    for (const child of children) child.assertRunning();
    if (ready) return;
    await delay(100);
  }
  throw new Error(
    `Fixture did not become ready within 60 seconds.\n${children.map((child) => child.output).join("\n")}`,
    { cause: lastError },
  );
}
