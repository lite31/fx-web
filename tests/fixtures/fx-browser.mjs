const state = (window.fxResetFixture = {
  created: 0,
  closes: [],
  prompts: [],
  pending: [],
  requestPrompt: undefined,
  failureStopReason: "error",
  hold: false,
  failCheckpoint: false,
});

export const supportsJspi = () => true;

export async function createFxEngine(options) {
  const id = ++state.created;
  let closing = false;
  let exited;
  const history = options.checkpoint
    ? JSON.parse(new TextDecoder().decode(options.checkpoint))
    : [];
  let active = false;
  return {
    prompt(text) {
      state.prompts.push({ id, text, closing });
      if (closing) throw new Error("fx agent is closed");
      const result = Promise.withResolvers();
      const release = Promise.withResolvers();
      state.release = release.resolve;
      let cancelled = false;
      active = true;
      return {
        result: result.promise,
        cancel() {
          cancelled = true;
          release.resolve();
        },
        async *[Symbol.asyncIterator]() {
          if (text.startsWith("add coffee once")) {
            const context = { signal: new AbortController().signal };
            const cart = JSON.parse(
              await options.tools.find((tool) => tool.name === "get_cart").execute({}, context),
            );
            await options.tools
              .find((tool) => tool.name === "set_cart_quantity")
              .execute(
                {
                  product_id: "coffee",
                  quantity: (cart.items.find((item) => item.id === "coffee")?.quantity ?? 0) + 1,
                },
                context,
              );
            state.mutated = true;
          }
          if (text.startsWith("exhaust app calls")) {
            const tool = options.tools.find((item) => item.name === "shop__get_cart");
            state.appCall = tool ? "missing result" : "missing tool";
            // fx hands a rejected tool call to the model as a result and keeps the turn going.
            await tool?.execute({}, { signal: new AbortController().signal }).then(
              () => (state.appCall = "succeeded"),
              (cause) => (state.appCall = cause.message),
            );
          }
          if (state.requestPrompt) {
            try {
              const response = await options.fetch(
                "https://ai-gateway.vercel.sh/v4/ai/language-model",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ prompt: state.requestPrompt }),
                },
              );
              await response.text();
            } catch {
              active = false;
              result.resolve({ stopReason: state.failureStopReason });
              return;
            }
          }
          if (state.hold) await release.promise;
          if (cancelled) {
            active = false;
            result.resolve({ stopReason: "cancelled" });
            return;
          }
          yield { type: "text_delta", delta: "Fixture reply" };
          history.push(text);
          active = false;
          result.resolve({ stopReason: "end_turn" });
        },
      };
    },
    async checkpoint() {
      if (active) throw new Error("cannot checkpoint while a prompt is active");
      if (state.failCheckpoint) throw new Error("Fixture checkpoint failed");
      if (state.oversizedCheckpoint) return new Uint8Array(4 * 1024 * 1024 + 3);
      return new TextEncoder().encode(JSON.stringify(history));
    },
    close() {
      state.closes.push(id);
      if (closing) return exited;
      closing = true;
      exited = new Promise((resolve, reject) => state.pending.push({ id, resolve, reject }));
      return exited;
    },
  };
}
