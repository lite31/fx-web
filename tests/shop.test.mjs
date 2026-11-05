import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createFxEngine } from "libfx/browser";
import { authenticate } from "../src/lib/auth-client.ts";
import { createShop } from "../src/lib/shop.ts";
import { shopTools } from "../src/lib/contract.ts";
import { createGatewayFetch } from "../src/lib/gateway-fetch.ts";
import { api } from "../src/lib/server/api.ts";
import { fixture, fixtureProducts, sessionIdentity } from "./fixture.ts";

const runTool = async (shop, name) =>
  JSON.parse(
    await shop.tools
      .find((tool) => tool.name === name)
      .execute({}, { signal: new AbortController().signal }),
  );

test("shop projects native auth responses and errors while retaining the signed-in cart", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  let cookie = "";
  const paths = [];
  let view;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    paths.push(url.slice(5));
    const response = await setup.browserFetch(url, init, cookie);
    const headers = response.headers.getSetCookie();
    if (headers.length) cookie = headers.map((header) => header.split(";")[0]).join("; ");
    return response;
  });
  await shop.load();
  assert.equal(view.user, null);
  paths.length = 0;
  const user = await authenticate(
    { username: " Shop_User ", email: "shop@example.com", password: "shop-user-password" },
    true,
  );
  assert.equal(user.username, "shop_user");
  assert.deepEqual(paths, ["auth/sign-up/email"]);
  assert.equal(view.user, null);
  await shop.load();
  assert.equal(view.user.username, "shop_user");
  assert.equal(view.cart.count, 0);
  await shop.setQuantity({ product_id: "coffee", quantity: 2 });
  await shop.logout();
  assert.equal(view.user, null);
  assert.equal(view.cart, null);
  paths.length = 0;
  await assert.rejects(authenticate({ username: "x", password: "short" }, false));
  assert.deepEqual(paths, []);
  await assert.rejects(
    authenticate({ username: "shop_user", password: "incorrect-password" }, false),
    /Invalid username or password/,
  );
  await authenticate({ username: " SHOP_USER ", password: "shop-user-password" }, false);
  await shop.load();
  assert.equal(view.user.username, "shop_user");
  assert.equal(view.cart.totalCents, 1000);
  await assert.rejects(
    authenticate({ username: "shop_user", password: "incorrect-password" }, false),
    /Invalid username or password/,
  );
  await assert.rejects(
    authenticate({ username: "shop_user", password: "shop-user-password" }, false),
    { name: "Error", message: "Too many requests. Please try again later." },
  );
  assert.equal(view.user.username, "shop_user");
  assert.equal(view.cart.totalCents, 1000);
});

test("a rejected checkout refreshes catalog prices and requires a new review", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  let view;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  t.mock.method(globalThis, "fetch", async (url, init) => setup.browserFetch(url, init));
  await shop.load();
  await shop.setQuantity({ product_id: "coffee", quantity: 2 });
  const quote = await shop.prepareCheckout();
  setup.commerce.importCatalog([{ ...fixtureProducts[0], priceCents: 600 }]);
  await assert.rejects(shop.confirmCheckout(quote.id), /Prices changed/);
  assert.equal(view.quote, null);
  assert.equal(view.cart.totalCents, 1200);
  assert.equal(view.products.find((product) => product.id === "coffee").priceCents, 600);
  assert.equal(setup.commerce.catalog().products[0].stock, 10);
});

test("a recorded order survives failed cart or catalog refresh and recovers without a second order", async (t) => {
  for (const path of ["cart", "catalog"]) {
    await t.test(path, async (t) => {
      const setup = await fixture();
      t.after(() => setup.runtime.close());
      let view;
      let failRefresh = false;
      const shop = createShop((updated) => {
        view = updated;
      });
      t.after(() => shop.dispose());
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (failRefresh && url === `/api/${path}`) throw new Error("Refresh disconnected.");
        return setup.browserFetch(url, init);
      });
      await shop.load();
      await shop.setQuantity({ product_id: "coffee", quantity: 2 });
      const quote = await shop.prepareCheckout();
      failRefresh = true;
      const order = await shop.confirmCheckout(quote.id);
      assert.deepEqual(view.order, order);
      assert.equal(view.quote, null);
      assert.equal(view.busy, false);
      assert.match(view.refreshWarning, /Order recorded.*Refresh before shopping again/);
      assert.equal(setup.commerce.cart(setup.session.userId).count, 0);
      assert.equal(setup.commerce.catalog().products[0].stock, 8);
      assert.deepEqual(await shop.confirmCheckout(quote.id), order);
      assert.equal(setup.commerce.catalog().products[0].stock, 8);
      await assert.rejects(shop.load(), /Refresh disconnected/);
      assert.ok(view.refreshWarning);
      assert.deepEqual(view.order, order);
      failRefresh = false;
      await shop.load();
      assert.equal(view.refreshWarning, "");
      assert.equal(view.cart.count, 0);
      assert.equal(view.products.find((product) => product.id === "coffee").stock, 8);
      assert.deepEqual(view.order, order);
    });
  }
});

test("a rejected checkout retains its rejection when the catalog refresh fails", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  let view;
  let failRefresh = false;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (failRefresh && url === "/api/catalog") throw new Error("Refresh disconnected.");
    return setup.browserFetch(url, init);
  });
  await shop.load();
  await shop.setQuantity({ product_id: "coffee", quantity: 2 });
  const quote = await shop.prepareCheckout();
  setup.commerce.importCatalog([{ ...fixtureProducts[0], priceCents: 600 }]);
  failRefresh = true;
  await assert.rejects(shop.confirmCheckout(quote.id), /Prices changed/);
  assert.equal(view.order, null);
  assert.equal(view.quote, null);
  assert.equal(view.busy, false);
  assert.match(view.refreshWarning, /Products could not refresh/);
  assert.doesNotMatch(view.refreshWarning, /Order recorded/);
  assert.equal(setup.commerce.catalog().products[0].stock, 10);
  assert.equal(setup.commerce.cart(setup.session.userId).count, 2);
});

test("change refresh waits for both reads and respects identity changes and disposal", async (t) => {
  for (const { source, change } of ["checkout", "app"].flatMap((source) =>
    ["unauthorized", "switch", "dispose"].map((change) => ({ source, change })),
  )) {
    await t.test(`${source}: ${change}`, async (t) => {
      const setup = await fixture();
      t.after(() => setup.runtime.close());
      const buyer = await setup.authenticate("refresh_buyer", "refresh-buyer-password");
      let cookie = setup.cookie;
      const snapshots = [];
      const cleared = Promise.withResolvers();
      let holdRefresh = false;
      const shop = createShop((updated) => {
        snapshots.push(updated);
        if (holdRefresh && !updated.user) cleared.resolve();
      });
      t.after(() => shop.dispose());
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      t.after(() => release.resolve());
      t.mock.method(globalThis, "fetch", async (url, init) => {
        const holdCart = holdRefresh && url === "/api/cart";
        const unauthorized = holdRefresh && change === "unauthorized" && url === "/api/catalog";
        const response = await setup.browserFetch(url, init, unauthorized ? buyer.cookie : cookie);
        if (holdCart) {
          entered.resolve();
          await release.promise;
        }
        return response;
      });
      await shop.load();
      await shop.setQuantity({ product_id: "coffee", quantity: 2 });
      const quote = source === "checkout" ? await shop.prepareCheckout() : null;
      holdRefresh = true;
      let settled = false;
      const refresh = quote
        ? shop.confirmCheckout(quote.id)
        : shop.refreshAfterChange(shop.account().signal);
      void refresh.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = assert.rejects(refresh, { name: "AbortError" });
      await entered.promise;
      if (change === "unauthorized") {
        await cleared.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "refresh must await the delayed cart read");
      }
      holdRefresh = false;
      if (change === "dispose") shop.dispose();
      else {
        cookie = buyer.cookie;
        await shop.load();
      }
      const beforeRelease = snapshots.length;
      release.resolve();
      await rejected;
      assert.equal(snapshots.length, beforeRelease);
      if (change !== "dispose") {
        assert.equal(snapshots.at(-1).user.id, buyer.session.userId);
        assert.equal(snapshots.at(-1).order, null);
        assert.equal(snapshots.at(-1).refreshWarning, "");
        assert.equal(snapshots.at(-1).cart.count, 0);
      }
      assert.equal(setup.commerce.cart(setup.session.userId).count, quote ? 0 : 2);
      assert.equal(setup.commerce.catalog().products[0].stock, quote ? 8 : 10);
    });
  }
});

test("change refresh cancellation propagates before ordinary read failures become warnings", async (t) => {
  for (const source of ["checkout", "app"]) {
    await t.test(source, async (t) => {
      const setup = await fixture();
      t.after(() => setup.runtime.close());
      let view;
      let cancelRefresh = false;
      const shop = createShop((updated) => {
        view = updated;
      });
      t.after(() => shop.dispose());
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (cancelRefresh && url === "/api/cart") throw new Error("Refresh disconnected.");
        if (cancelRefresh && url === "/api/catalog")
          throw new DOMException("Cancelled", "AbortError");
        return setup.browserFetch(url, init);
      });
      await shop.load();
      await shop.setQuantity({ product_id: "coffee", quantity: 2 });
      const quote = source === "checkout" ? await shop.prepareCheckout() : null;
      cancelRefresh = true;
      await assert.rejects(
        quote ? shop.confirmCheckout(quote.id) : shop.refreshAfterChange(shop.account().signal),
        { name: "AbortError" },
      );
      assert.equal(Boolean(view.order), source === "checkout");
      assert.equal(view.quote, null);
      assert.equal(view.busy, false);
      assert.equal(view.refreshWarning, "");
      assert.equal(setup.commerce.catalog().products[0].stock, quote ? 8 : 10);
    });
  }
});

test("an App change warning stays generic with an older receipt and remains until explicit refresh", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  let view;
  let failRefresh = false;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (failRefresh && url === "/api/cart") throw new Error("Refresh disconnected.");
    return setup.browserFetch(url, init);
  });
  await shop.load();
  await shop.setQuantity({ product_id: "coffee", quantity: 2 });
  const quote = await shop.prepareCheckout();
  const order = await shop.confirmCheckout(quote.id);
  const cart = setup.commerce.cart(setup.session.userId);
  const changed = await setup.request("cart/quantity", {
    product_id: "coffee",
    quantity: 1,
    expectedRevision: cart.revision,
  });
  assert.equal(changed.status, 200);
  failRefresh = true;
  await shop.refreshAfterChange(shop.account().signal);
  assert.equal(
    view.refreshWarning,
    "Cart or products could not refresh. Refresh before shopping again.",
  );
  assert.deepEqual(view.order, order);
  failRefresh = false;
  await shop.refreshAfterChange(shop.account().signal);
  assert.equal(view.cart.count, 1);
  assert.ok(view.refreshWarning);
  await shop.load();
  assert.equal(view.refreshWarning, "");
  assert.deepEqual(view.order, order);
});

test("an older load cannot clear a newer App change warning before explicit recovery", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  let view;
  let holdCart = false;
  let failNextCart = false;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  const captured = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (failNextCart && url === "/api/cart") {
      failNextCart = false;
      throw new Error("Refresh disconnected.");
    }
    const response = await setup.browserFetch(url, init);
    if (holdCart && url === "/api/cart") {
      holdCart = false;
      captured.resolve();
      await release.promise;
    }
    return response;
  });
  await shop.load();
  await shop.setQuantity({ product_id: "coffee", quantity: 1 });
  holdCart = true;
  const olderLoad = shop.load();
  await captured.promise;
  const changed = await setup.request("cart/quantity", {
    product_id: "coffee",
    quantity: 2,
    expectedRevision: view.cart.revision,
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).count, 2);
  failNextCart = true;
  await shop.refreshAfterChange(shop.account().signal);
  const warning = view.refreshWarning;
  assert.match(warning, /Cart or products could not refresh/);
  release.resolve();
  await olderLoad;
  assert.equal(view.refreshWarning, warning, "An older load must preserve a newer warning.");
  assert.equal(view.cart.count, 1);
  await shop.load();
  assert.equal(view.cart.count, 2);
  assert.equal(view.refreshWarning, "");
});

test("a stale App change cannot start reads after the account changes", async (t) => {
  let view;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  const captured = shop.account().signal;
  await shop.logout();
  const before = view;
  // Refresh settles its reads together, so a throwing mock would be swallowed; count requests.
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 500 }));
  await assert.rejects(shop.refreshAfterChange(captured), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 0, "Stale refresh must not send requests.");
  assert.deepEqual(view, before);
});

test("a delayed cart read returns the latest acknowledged cart to the agent and UI", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  let view;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  const captured = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let holdRead = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = url.slice(5);
    const response = await setup.browserFetch(url, init);
    if (holdRead && path === "cart") {
      holdRead = false;
      captured.resolve();
      await release.promise;
    }
    return response;
  });
  await shop.load();
  holdRead = true;
  const earlier = runTool(shop, "get_cart");
  await captured.promise;
  await shop.setQuantity({ product_id: "coffee", quantity: 2 });
  release.resolve();
  assert.equal((await earlier).totalCents, 1000);
  assert.equal(view.cart.totalCents, 1000);
});

test("a delayed catalog tool shares the latest successful products with the UI", async (t) => {
  for (const scenario of ["newer published", "newer failed", "first publication failed"]) {
    await t.test(scenario, async (t) => {
      const setup = await fixture();
      t.after(() => setup.runtime.close());
      let view;
      let failCatalog = scenario === "first publication failed";
      let holdRead = false;
      const shop = createShop((updated) => {
        view = updated;
      });
      t.after(() => shop.dispose());
      const captured = Promise.withResolvers();
      const release = Promise.withResolvers();
      t.after(() => release.resolve());
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (failCatalog && url === "/api/catalog") throw new Error("Catalog disconnected.");
        const response = await setup.browserFetch(url, init);
        if (holdRead && url === "/api/catalog") {
          holdRead = false;
          captured.resolve();
          await release.promise;
        }
        return response;
      });
      if (failCatalog) await assert.rejects(shop.load(), /Catalog disconnected/);
      else await shop.load();
      failCatalog = false;
      if (scenario === "newer failed")
        setup.commerce.importCatalog([{ ...fixtureProducts[0], priceCents: 600 }]);
      holdRead = true;
      const tool = shop.tools.find((tool) => tool.name === "list_products");
      assert.ok(tool);
      const earlier = tool.execute({}, { signal: new AbortController().signal });
      await captured.promise;
      setup.commerce.importCatalog([
        { ...fixtureProducts[0], priceCents: scenario === "newer failed" ? 700 : 600 },
      ]);
      failCatalog = scenario !== "newer published";
      if (failCatalog) await assert.rejects(runTool(shop, "list_products"), /Catalog disconnected/);
      else await runTool(shop, "list_products");
      release.resolve();
      const result = JSON.parse(await earlier);
      const price = (products) => products.find((product) => product.id === "coffee").priceCents;
      assert.equal(result.currency, "EUR");
      assert.deepEqual(Object.keys(result).sort(), ["currency", "products"]);
      assert.deepEqual(result.products, view.products);
      if (scenario === "newer published") {
        assert.equal(price(result.products), 600);
      } else {
        assert.equal(price(result.products), scenario === "newer failed" ? 600 : 500);
      }
    });
  }
});

test("empty shop snapshots stay independent across controllers and identity resets", async (t) => {
  let firstView;
  let secondView;
  const first = createShop((view) => {
    firstView = view;
  });
  const second = createShop((view) => {
    secondView = view;
  });
  t.after(() => first.dispose());
  t.after(() => second.dispose());
  await first.logout();
  await second.logout();
  const previous = firstView;
  previous.products.push(fixtureProducts[0]);
  assert.deepEqual(secondView.products, []);
  await first.logout();
  assert.deepEqual(firstView.products, []);
  assert.equal(previous.products.length, 1);
});

test("async shop serializes writes, cancels queued work and suppresses responses after account changes", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  const snapshots = [];
  const shop = createShop((view) => snapshots.push(view));
  t.after(() => shop.dispose());
  const pending = Promise.withResolvers();
  let hold = false;
  let dispatched = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = url.slice(5);
    if (path === "cart/quantity") dispatched++;
    const response = await setup.browserFetch(url, init);
    if (hold && path === "cart/quantity") await pending.promise;
    return response;
  });
  await shop.load();
  const mutation = shop.tools.find((tool) => tool.name === "set_cart_quantity");
  assert.ok(mutation);
  await mutation.execute(
    { product_id: "coffee", quantity: 2 },
    { signal: new AbortController().signal },
  );
  assert.equal(snapshots.at(-1).cart.totalCents, 1000);
  await assert.rejects(
    mutation.execute({ product_id: "coffee", quantity: 0 }, { signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
  assert.equal(dispatched, 1);
  hold = true;
  const first = shop.setQuantity({ product_id: "coffee", quantity: 3 });
  const abort = new AbortController();
  const queued = mutation.execute({ product_id: "coffee", quantity: 0 }, { signal: abort.signal });
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  const queuedRejected = assert.rejects(queued, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await shop.logout();
  pending.resolve();
  await Promise.all([firstRejected, queuedRejected]);
  assert.equal(dispatched, 2);
  assert.equal(snapshots.at(-1).user, null);
  assert.equal(snapshots.at(-1).cart, null);
  await assert.rejects(
    mutation.execute(
      { product_id: "coffee", quantity: 1 },
      { signal: new AbortController().signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(dispatched, 2);
});

test("installed fx WASM restores SQLite checkpoints without replaying tools and retains results on follow-up turns", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  const shop = createShop(() => {});
  t.after(() => shop.dispose());
  const calls = [
    { name: "list_products", input: {} },
    { name: "get_cart", input: {} },
    { name: "set_cart_quantity", input: { product_id: "coffee", quantity: 2 } },
    { name: "set_cart_quantity", input: { product_id: "coffee", quantity: -1 } },
    { name: "set_cart_quantity", input: { product_id: "coffee", quantity: 0 } },
  ];
  const requests = [];
  const results = [];
  let index = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (typeof _url === "string" && _url.startsWith("/api/") && _url !== "/api/generate")
      return setup.browserFetch(_url, init);
    if (_url === "/api/generate") {
      const headers = new Headers(init.headers);
      assert.equal(headers.has("authorization"), false);
      headers.set("origin", "http://localhost");
      headers.set("content-type", "application/json");
      headers.set("cookie", setup.cookie);
      const payload = JSON.parse(init.body);
      payload.tools[0].description = "Untrusted browser instruction";
      payload.tools[0].inputSchema = { type: "string" };
      const response = await api.request(
        "http://localhost/api/generate",
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: init.signal,
        },
        setup.environment,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response;
    }
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-server-secret");
    const request = JSON.parse(init.body);
    requests.push(request);
    assert.deepEqual(
      request.tools.toSorted((a, b) => a.name.localeCompare(b.name)),
      shopTools
        .map((tool) => ({ type: "function", ...tool }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    );
    const last = request.prompt.at(-1);
    let parts;
    if (last.role === "tool") {
      results.push(last.content[0].output);
      parts = [
        { type: "text-start", id: "reply" },
        { type: "text-delta", id: "reply", delta: "Done." },
        { type: "text-end", id: "reply" },
        { type: "finish", finishReason: { unified: "stop" } },
      ];
    } else {
      const call = calls[index++];
      assert.ok(call, "Unexpected extra generation");
      parts = [
        { type: "tool-input-start", id: `call-${index}`, toolName: call.name },
        { type: "tool-call", toolCallId: `call-${index}`, toolName: call.name, input: call.input },
        { type: "finish", finishReason: { unified: "tool-calls" } },
      ];
    }
    return new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  await shop.load();
  await shop.setQuantity({ product_id: "plant", quantity: 1 });
  const options = {
    apiKey: "browser-placeholder",
    model: "test-model",
    tools: shop.tools,
    wasm: await readFile(new URL("./fx-core.wasm", import.meta.resolve("libfx/browser"))),
    fetch: createGatewayFetch({
      reportError: (message) => {
        assert.fail(message);
      },
      account: shop.account(),
    }),
  };
  let agent = await createFxEngine(options);
  let restoredPrefix;
  let restoredRequestIndex;
  t.after(() => agent.close());
  for (const call of calls) {
    const turn = agent.prompt(`Please ${call.name}.`);
    let reply = "";
    for await (const event of turn) if (event.type === "text_delta") reply += event.delta;
    assert.equal((await turn.result).stopReason, "end_turn");
    assert.equal(reply, "Done.");
    if (restoredPrefix && restoredRequestIndex !== undefined) {
      assert.deepEqual(
        requests[restoredRequestIndex].prompt.slice(0, restoredPrefix.length),
        restoredPrefix,
        "The first explicit follow-up must retain the completed user messages and tool results",
      );
      restoredPrefix = undefined;
    }
    if (call === calls[2]) {
      const turnId = crypto.randomUUID();
      const begin = await setup.request("chat", {
        kind: "begin",
        revision: 0,
        operationId: crypto.randomUUID(),
        turnId,
        prompt: "Saved tool turn",
      });
      assert.equal(begin.status, 200);
      const checkpoint = await agent.checkpoint();
      const saved = await setup.request("chat", {
        kind: "complete",
        revision: 1,
        operationId: crypto.randomUUID(),
        turnId,
        checkpoint: Buffer.from(checkpoint).toString("base64"),
        messages: [{ kind: "text", id: "reply", role: "assistant", text: "Done." }],
        limited: false,
      });
      assert.equal(saved.status, 200);
      const before = setup.commerce.cart(setup.session.userId);
      const modelCalls = requests.length;
      const toolCalls = results.length;
      restoredPrefix = requests.at(-1).prompt;
      restoredRequestIndex = modelCalls;
      await agent.close();
      const history = await (await setup.request("chat")).json();
      agent = await createFxEngine({
        ...options,
        checkpoint: Buffer.from(history.checkpoint, "base64"),
      });
      assert.equal(requests.length, modelCalls, "Restoration must not call the model");
      assert.equal(results.length, toolCalls, "Restoration must not execute saved tools");
      assert.deepEqual(
        setup.commerce.cart(setup.session.userId),
        before,
        "Restoring a mutation result must not change the cart or revision",
      );
    }
  }
  assert.equal(requests.length, 10);
  assert.equal(JSON.parse(results[0].value).products.length, 2);
  assert.equal(JSON.parse(results[1].value).items[0].id, "plant");
  assert.equal(JSON.parse(results[2].value).subtotalCents, 2800);
  assert.equal(results[3].type, "error-text");
  assert.equal(JSON.parse(results[4].value).subtotalCents, 1800);
  assert.equal(setup.commerce.cart(setup.session.userId).count, 1);
});

test("a stale tab cannot read, write, check out, generate or sign out the new cookie account", async (t) => {
  for (const action of ["cart", "catalog", "quantity", "quote", "confirm", "generate", "logout"]) {
    await t.test(action, async (t) => {
      const setup = await fixture();
      t.after(() => setup.runtime.close());
      const buyer = await setup.authenticate("buyer_b", "buyer-b-password");
      await setup.request(
        "cart/quantity",
        { product_id: "plant", quantity: 1, expectedRevision: 0 },
        buyer.cookie,
      );
      const buyerQuote = await (await setup.request("checkout/quote", {}, buyer.cookie)).json();
      let cookie = setup.cookie;
      let view;
      const shop = createShop((updated) => {
        view = updated;
      });
      t.after(() => shop.dispose());
      let gatewayCalls = 0;
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (!url.startsWith("/api/")) {
          gatewayCalls++;
          return new Response("unexpected Gateway call");
        }
        return setup.browserFetch(url, init, cookie);
      });
      await shop.load();
      await shop.setQuantity({ product_id: "coffee", quantity: 1 });
      await shop.prepareCheckout();
      const oldUserId = view.user.id;
      const oldMutation = shop.tools.find((tool) => tool.name === "set_cart_quantity");
      const modelFetch = createGatewayFetch({
        reportError: () => {},
        account: shop.account(),
      });
      cookie = buyer.cookie;
      const run = {
        cart: () => runTool(shop, "get_cart"),
        catalog: () => runTool(shop, "list_products"),
        quantity: () =>
          oldMutation.execute(
            { product_id: "coffee", quantity: 1 },
            { signal: new AbortController().signal },
          ),
        quote: () => shop.prepareCheckout(),
        confirm: () => shop.confirmCheckout(buyerQuote.id),
        generate: () =>
          modelFetch("https://ai-gateway.vercel.sh/v4/ai/language-model", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            }),
          }),
        logout: () => shop.logout(),
      }[action];
      if (action === "logout") await run();
      else await assert.rejects(run(), /Sign in to continue/);
      assert.equal(view.user, null);
      assert.equal(view.cart, null);
      assert.equal(view.quote, null);
      assert.deepEqual(view.products, []);
      await assert.rejects(
        oldMutation.execute(
          { product_id: "coffee", quantity: 0 },
          { signal: new AbortController().signal },
        ),
        { name: "AbortError" },
      );
      assert.equal(setup.commerce.cart(buyer.session.userId).totalCents, 1800);
      assert.equal(setup.commerce.cart(setup.session.userId).totalCents, 500);
      assert.equal(setup.commerce.catalog().products[0].stock, 10);
      assert.ok(await sessionIdentity(setup.runtime, new Headers({ cookie: buyer.cookie })));
      assert.equal(gatewayCalls, 0);
      const [path, input] = {
        cart: ["cart", undefined],
        catalog: ["catalog", undefined],
        quantity: ["cart/quantity", { product_id: "coffee", quantity: 1, expectedRevision: 1 }],
        quote: ["checkout/quote", {}],
        confirm: ["checkout/confirm", { quoteId: buyerQuote.id }],
        generate: [
          "generate",
          { prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] },
        ],
        logout: ["auth/sign-out", {}],
      }[action];
      for (const expected of ["", oldUserId]) {
        const rejected = await setup.request(path, input, buyer.cookie, expected);
        assert.equal(rejected.status, 401);
      }
      assert.ok(await sessionIdentity(setup.runtime, new Headers({ cookie: buyer.cookie })));
    });
  }
});

test("sign-out retries retain the original account after clearing shop state", async (t) => {
  for (const switched of [false, true]) {
    await t.test(switched ? "other tab signed in" : "same account", async (t) => {
      const setup = await fixture();
      t.after(() => setup.runtime.close());
      const buyer = switched
        ? await setup.authenticate("retry_buyer", "retry-buyer-password")
        : null;
      let cookie = setup.cookie;
      let view;
      let attempts = 0;
      const shop = createShop((updated) => {
        view = updated;
      });
      t.after(() => shop.dispose());
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (url === "/api/auth/sign-out" && ++attempts === 1) throw new Error("Connection lost.");
        return setup.browserFetch(url, init, cookie);
      });
      await shop.load();
      await assert.rejects(shop.logout(), /Connection lost/);
      assert.equal(view.user, null);
      assert.equal(view.loading, false);
      assert.ok(await sessionIdentity(setup.runtime, new Headers({ cookie })));
      if (buyer) cookie = buyer.cookie;
      await shop.logout();
      assert.equal(attempts, 2);
      assert.equal(view.loading, false);
      const identity = await sessionIdentity(setup.runtime, new Headers({ cookie }));
      if (buyer) assert.equal(identity.userId, buyer.session.userId);
      else assert.equal(identity, null);
    });
  }
});

test("a late model rejection cannot clear a newly loaded account", async (t) => {
  const setup = await fixture();
  t.after(() => setup.runtime.close());
  const buyer = await setup.authenticate("late_buyer", "late-buyer-password");
  let cookie = setup.cookie;
  let view;
  const shop = createShop((updated) => {
    view = updated;
  });
  t.after(() => shop.dispose());
  const captured = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const response = await setup.browserFetch(url, init, cookie);
    if (url === "/api/generate") {
      captured.resolve();
      await release.promise;
    }
    return response;
  });
  await shop.load();
  const modelFetch = createGatewayFetch({ reportError: () => {}, account: shop.account() });
  cookie = buyer.cookie;
  const pending = modelFetch("https://ai-gateway.vercel.sh/v4/ai/language-model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }),
  });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await captured.promise;
  await shop.load();
  release.resolve();
  await rejected;
  assert.equal(view.user.id, buyer.session.userId);
  assert.equal(view.cart.count, 0);
  assert.equal(view.products.length, 2);
});
