import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createFxEngine } from "libfx/browser";
import { createAccount } from "../src/lib/account.ts";
import { createGatewayFetch } from "../src/lib/gateway-fetch.ts";
import { api } from "../src/lib/server/api.ts";
import { fixture } from "./fixture.ts";

test("installed fx history hits message and byte caps and a replacement agent can reply", async (t) => {
  const wasm = await readFile(new URL("./fx-core.wasm", import.meta.resolve("libfx/browser")));
  for (const [name, text, reply, expectedStatus] of [
    ["message count", "Hello", "Fixture reply", 400],
    ["body bytes", "x".repeat(2000), "y".repeat(2000), 413],
  ]) {
    await t.test(name, async (t) => {
      const setup = await fixture();
      t.after(() => setup.runtime.close());
      const requests = [];
      const errors = [];
      let limits = 0;
      let gatewayCalls = 0;
      t.mock.method(globalThis, "fetch", async (input, init) => {
        if (input === "/api/generate") {
          const headers = new Headers(init.headers);
          headers.set("origin", "http://localhost");
          headers.set("cookie", setup.cookie);
          const response = await api.request(
            "http://localhost/api/generate",
            { ...init, headers },
            setup.environment,
          );
          requests.push({
            messages: JSON.parse(init.body).prompt.length,
            bytes: Buffer.byteLength(init.body),
            status: response.status,
          });
          return response;
        }
        assert.equal(input, "https://ai-gateway.vercel.sh/v4/ai/language-model");
        gatewayCalls++;
        const parts = [
          { type: "text-start", id: "reply" },
          { type: "text-delta", id: "reply", delta: reply },
          { type: "text-end", id: "reply" },
          { type: "finish", finishReason: { unified: "stop" } },
        ];
        return new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const create = () =>
        createFxEngine({
          wasm,
          apiKey: "fixture-placeholder",
          model: "test-model",
          fetch: createGatewayFetch({
            account: createAccount({
              userId: setup.session.userId,
              signal: new AbortController().signal,
              onUnauthorized: () => assert.fail("The fixture account must remain signed in"),
            }),
            onConversationLimit: () => limits++,
            reportError: (message) => errors.push(message),
          }),
        });
      const run = async (agent, prompt) => {
        const turn = agent.prompt(prompt);
        const result = turn.result.catch((error) => ({ stopReason: "error", error }));
        let output = "";
        try {
          for await (const event of turn) if (event.type === "text_delta") output += event.delta;
        } catch (error) {
          assert.equal((await result).error, error);
        }
        return { output, result: await result };
      };
      const exhausted = await create();
      t.after(() => exhausted.close());
      let successfulTurns = 0;
      for (let turn = 0; turn < 21; turn++) {
        const response = await run(exhausted, text);
        if (response.result.stopReason !== "end_turn") break;
        assert.equal(response.output, reply);
        successfulTurns++;
      }
      assert.ok(successfulTurns > 0 && successfulTurns <= 20);
      const failedRequest = requests.at(-1);
      assert.equal(failedRequest.status, expectedStatus);
      assert.ok(limits > 0, "fx must report that this history requires a new conversation");
      assert.equal(
        errors.at(-1),
        "This conversation reached its limit. Start a new conversation to continue.",
      );
      if (expectedStatus === 400) {
        assert.equal(successfulTurns, 20);
        assert.equal(failedRequest.messages, 41);
      } else {
        assert.ok(failedRequest.messages <= 40);
        assert.ok(failedRequest.bytes > 64 * 1024);
      }
      const acceptedCalls = gatewayCalls;
      const repeated = await run(exhausted, "A short retry cannot remove retained history");
      assert.notEqual(repeated.result.stopReason, "end_turn");
      assert.equal(requests.at(-1).status, expectedStatus);
      assert.equal(gatewayCalls, acceptedCalls, "An exhausted history must not reach Gateway");
      await exhausted.close();
      const replacement = await create();
      t.after(() => replacement.close());
      const recovered = await run(replacement, "After reset");
      assert.equal(recovered.result.stopReason, "end_turn");
      assert.equal(recovered.output, reply);
      assert.equal(requests.at(-1).messages, 1);
      assert.equal(gatewayCalls, acceptedCalls + 1);
      console.log(
        `PASS installed fx ${name}: ${successfulTurns} replies, ${failedRequest.messages} messages, ${failedRequest.bytes} bytes, HTTP ${expectedStatus}; replacement replied.`,
      );
    });
  }
});
