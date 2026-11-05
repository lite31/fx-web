import { onMount, tick } from "svelte";
import type { Account } from "$lib/account";
import { createGatewayFetch } from "$lib/gateway-fetch";
import {
  ApiError,
  modelConfigSchema,
  type HostView,
  chatCommandSchema,
  chatSnapshotSchema,
  type ChatCommand,
  type ChatMessage,
  type ChatSnapshot,
} from "$lib/contract";
import { createMcpApps, type McpApps } from "$lib/mcp-apps";
import type { Shop } from "$lib/shop";
import type { FxEngine, FxEngineTurn } from "libfx/browser";

type ChatBindings = {
  readonly shop: Shop;
  model: string;
  ready: boolean;
};

type Entry =
  | { kind: "text"; id: string; role: "user" | "assistant"; text: string }
  | { kind: "app"; id: string; view: HostView; apps: McpApps }
  | { kind: "historical-app"; id: string; title: string };

const limitStatus = "Conversation limit reached. Start a new conversation to continue.";

// One mounted Chat owns the fx engine, MCP views, and save recovery together.
// Each async step captures `scope` when it starts and stops once that scope aborts:
// on logout or account switch (the account), or on reset or unmount (the conversation).
export function createChatController(bindings: ChatBindings) {
  let account: Account;
  // reset() replaces the conversation; dispose() aborts it for good.
  let conversation = new AbortController();
  let scope: Account;

  let agent = $state<FxEngine>();
  let apps = $state.raw<McpApps>();
  let activeTurn: FxEngineTurn | undefined;
  let stopRequested = false;
  let prompt = $state("");
  let busy = $state(false);
  let initializing = $state(false);
  let conversationLimited = $state(false);
  let status = $state("Sign in to shop and chat.");
  let error = $state("");
  let transportError = "";
  let saved = $state.raw<ChatSnapshot>();
  let interrupted = $state(false);
  let historyBlocked = $state(false);
  let recovery = $state.raw<{ retry: () => Promise<void>; input?: ChatCommand }>();
  let messages = $state<Entry[]>([]);
  let composer = $state<HTMLTextAreaElement | null>(null);
  let log: HTMLDivElement;
  let followConversation = true;

  function canSend() {
    return (
      Boolean(agent) &&
      !busy &&
      !conversationLimited &&
      !interrupted &&
      !historyBlocked &&
      !recovery
    );
  }
  function canReset() {
    return !busy && !initializing && Boolean(saved) && !historyBlocked && !recovery?.input;
  }
  function canDiscard() {
    return !busy && !historyBlocked && !recovery;
  }

  async function historyRequest(captured: Account, input?: ChatCommand) {
    try {
      return await captured.json("chat", chatSnapshotSchema, {
        json: input && chatCommandSchema.parse(input),
        failure: "Unable to save or load chat.",
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && !captured.signal.aborted)
        historyBlocked = true;
      throw cause;
    }
  }

  // Saved app entries retain titles only. Reconnecting old views would restore live
  // capabilities, so opening an interactive card requires a fresh tool call.
  function restoreMessages(snapshot: ChatSnapshot) {
    messages = snapshot.messages.map((entry) =>
      entry.kind === "app" ? { ...entry, kind: "historical-app" } : entry,
    );
    if (snapshot.pending)
      messages.push({
        kind: "text",
        id: snapshot.pending.turnId,
        role: "user",
        text: snapshot.pending.prompt,
      });
  }

  function displayHistory(): ChatMessage[] {
    return messages.map((entry) =>
      entry.kind === "text"
        ? { ...entry }
        : {
            kind: "app",
            id: entry.id,
            title: entry.kind === "app" ? entry.view.title : entry.title,
          },
    );
  }

  async function persist(command: () => Promise<ChatCommand>, after: () => void | Promise<void>) {
    const captured = scope;
    if (captured.signal.aborted) return;
    busy = true;
    recovery = undefined;
    error = "";
    let input: ChatCommand | undefined;
    try {
      input = await command();
      if (captured.signal.aborted) return;
      const snapshot = await historyRequest(captured, input);
      if (captured.signal.aborted) return;
      saved = snapshot;
      await after();
    } catch (cause) {
      if (captured.signal.aborted) return;
      error = cause instanceof Error ? cause.message : "Unable to save chat.";
      status = historyBlocked
        ? "Chat changed. Reload saved chat before continuing."
        : "Chat is not saved. Retry saving before sending another message.";
      if (!historyBlocked) {
        // Reuse an already prepared command, including its operation ID, when a save
        // may have committed but its acknowledgement was lost. Never rerun the fx turn.
        const prepared = input;
        recovery = {
          retry: () => persist(prepared ? async () => prepared : command, after),
          input: prepared,
        };
      }
    } finally {
      if (!captured.signal.aborted) busy = false;
    }
  }

  // Streaming text and app resizing can change layout without adding messages.
  // Follow those size changes only while the reader stays near the bottom.
  $effect(() => {
    if (!messages.length || !log) return;
    const resize = new ResizeObserver(() => {
      if (!conversation.signal.aborted && followConversation) log.scrollTop = log.scrollHeight;
    });
    for (const child of log.children) resize.observe(child);
    return () => resize.disconnect();
  });

  async function initialize() {
    const captured = scope;
    if (!captured.userId || captured.signal.aborted || initializing) return;
    initializing = true;
    let createdApps: McpApps | undefined;
    status = "Loading browser runtime…";
    try {
      const sdk = await import("libfx/browser");
      if (captured.signal.aborted) return;
      if (!sdk.supportsJspi()) {
        status = "This browser needs WebAssembly JSPI. Try current desktop Chrome or Edge.";
        return;
      }
      const config = await captured.json("config", modelConfigSchema).catch(() => {
        throw new Error("Unable to load the server configuration.");
      });
      if (captured.signal.aborted) return;
      bindings.model = config.model;
      const snapshot = await historyRequest(captured);
      if (captured.signal.aborted) return;
      saved = snapshot;
      restoreMessages(snapshot);
      interrupted = Boolean(snapshot.pending);
      conversationLimited = snapshot.limited;
      if (!config.configured) throw new Error("Set AI_GATEWAY_API_KEY in the server environment.");
      const onConversationLimit = () => {
        if (!captured.signal.aborted) conversationLimited = true;
      };
      createdApps = await createMcpApps({
        account: captured,
        onConversationLimit,
        onView: (view) => {
          if (!captured.signal.aborted && apps)
            messages.push({ kind: "app", id: view.id, view, apps });
        },
        onMessage: sendText,
        onChanged: () => {
          if (!captured.signal.aborted)
            void bindings.shop.refreshAfterChange(account.signal).catch(() => {});
        },
      });
      if (captured.signal.aborted) {
        await createdApps.close();
        return;
      }
      apps = createdApps;
      const proxyFetch = createGatewayFetch({
        account: captured,
        reportError: (message) => {
          if (!captured.signal.aborted) transportError = message;
        },
        conversationId: createdApps.conversation.id,
        onConversationLimit,
      });
      // Restore completed state as checkpoint bytes, not by prompting fx with old
      // messages. A pending marker blocks new turns until the user resolves it.
      const created = await sdk.createFxEngine({
        apiKey: "server-proxy",
        ...(snapshot.checkpoint
          ? {
              checkpoint: Uint8Array.from(atob(snapshot.checkpoint), (character) =>
                character.charCodeAt(0),
              ),
            }
          : {}),
        instructions: `You are the shop assistant. Distinguish browsing interest from explicit cart changes.
Interest such as "I'd like a coffee" means show matching products without changing the cart. Use shop__list_products with a concise product query to display the product card.
Only mutate the cart when the user explicitly asks to add, remove, or change a quantity. For an explicit add, first use native list_products and get_cart to read the product ID, stock and current quantity/revision without displaying extra cards, then use shop__set_cart_quantity with the new absolute quantity and expectedRevision. Its result displays the focused product card.
Card buttons update the cart directly. Once a product card is displayed, keep your reply short and do not repeat its catalog, prices, or stock in text.
Checkout requires the user's explicit review and confirmation in the shop. Never claim an order was placed by a cart change.`,
        model: bindings.model,
        fetch: proxyFetch,
        tools: [...bindings.shop.tools, ...createdApps.tools],
      });
      if (captured.signal.aborted) {
        await created.close();
        await createdApps.close();
        return;
      }
      agent = created;
      status = snapshot.pending
        ? "An unfinished turn was found. It will not be replayed."
        : snapshot.limited
          ? limitStatus
          : snapshot.messages.length
            ? "Saved conversation restored."
            : "";
    } catch (cause) {
      if (createdApps) {
        void createdApps.close();
        if (apps === createdApps) apps = undefined;
      }
      if (captured.signal.aborted) return;
      error = cause instanceof Error ? cause.message : "Unable to start the browser agent.";
      status = "Agent unavailable.";
    } finally {
      initializing = false;
    }
  }

  $effect(() => {
    bindings.ready = Boolean(agent);
  });

  onMount(() => {
    account = bindings.shop.account();
    scope = account.within(conversation.signal);
    void initialize();
    // Invalidate callbacks before closing resources. Async close results must not
    // publish into a replacement account or a page restored from the back/forward cache.
    const dispose = () => {
      if (conversation.signal.aborted) return;
      conversation.abort();
      void apps?.close();
      apps = undefined;
      bindings.ready = false;
      activeTurn?.cancel();
      void agent?.close();
      agent = undefined;
      saved = undefined;
      recovery = undefined;
      messages = [];
      prompt = "";
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener("pagehide", dispose);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", dispose);
      window.removeEventListener("pageshow", restore);
      dispose();
    };
  });

  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (sendText(prompt)) prompt = "";
  }

  function sendText(input: string) {
    const captured = scope;
    const text = input.trim();
    if (!canSend() || !agent || !saved || !text || text.length > 2_000 || captured.signal.aborted)
      return false;
    busy = true;
    stopRequested = false;
    error = "";
    transportError = "";
    messages.push({ kind: "text", id: crypto.randomUUID(), role: "user", text });
    const reply: Extract<Entry, { kind: "text" }> = $state({
      kind: "text",
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
    });
    messages.push(reply);
    status = "Saving your message…";
    const context = apps?.promptContext();
    void runTurn(agent, context ? `${text}\n\n${context}` : text, reply, captured, text);
    return true;
  }

  async function runTurn(
    currentAgent: FxEngine,
    text: string,
    reply: Extract<Entry, { kind: "text" }>,
    captured: Account,
    visiblePrompt: string,
  ) {
    const previous = saved;
    if (!previous) return;
    const turnId = crypto.randomUUID();
    // Persist the unfinished marker before any model or tool call. If this fails,
    // stop here because a lost acknowledgement leaves the durable state uncertain.
    try {
      const snapshot = await historyRequest(captured, {
        kind: "begin",
        revision: previous.revision,
        operationId: crypto.randomUUID(),
        turnId,
        prompt: visiblePrompt,
      });
      if (captured.signal.aborted) return;
      saved = snapshot;
    } catch (cause) {
      if (captured.signal.aborted) return;
      historyBlocked = true;
      reply.text = "Message was not sent to fx.";
      error = cause instanceof Error ? cause.message : "Unable to save your message.";
      status = "Reload saved chat before sending again. No model or tool call was started.";
      busy = false;
      return;
    }
    status = "fx is replying…";
    let outcomeError = "";
    try {
      if (stopRequested) {
        status = "Reply stopped.";
        reply.text = "Stopped before a reply arrived.";
        return;
      }
      const turn = currentAgent.prompt(text);
      activeTurn = turn;
      // Drain events before awaiting the result so SDK backpressure cannot stall a turn.
      for await (const event of turn) {
        if (captured.signal.aborted) break;
        if (event.type === "text_delta" && event.delta) {
          reply.text += event.delta;
          await tick();
        }
      }
      const result = await turn.result;
      if (captured.signal.aborted) return;
      if (transportError && (conversationLimited || result.stopReason !== "cancelled"))
        throw new Error(transportError);
      // A tool call can exhaust the conversation while the model still finishes its reply.
      status = conversationLimited
        ? limitStatus
        : result.stopReason === "cancelled"
          ? "Reply stopped."
          : result.stopReason === "end_turn"
            ? "Reply complete."
            : `Reply ended: ${result.stopReason}.`;
      if (!reply.text)
        reply.text =
          result.stopReason === "cancelled"
            ? "Stopped before a reply arrived."
            : "No text response received.";
    } catch (cause) {
      if (captured.signal.aborted) return;
      error = transportError || (cause instanceof Error ? cause.message : "The reply failed.");
      outcomeError = error;
      if (!reply.text) reply.text = "No response received.";
      status = conversationLimited ? limitStatus : "Reply failed. You can try again.";
    } finally {
      if (!captured.signal.aborted) {
        activeTurn = undefined;
        const outcomeStatus = status;
        const revision = saved?.revision;
        // A stopped or failed turn may already have changed the cart. Save its
        // settled fx state and displayed history together before allowing another turn.
        let completion: ChatCommand | undefined;
        await persist(
          async () => {
            if (completion) return completion;
            if (revision === undefined) throw new Error("Chat is no longer available.");
            const bytes = await currentAgent.checkpoint();
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 0x8000)
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
            completion = chatCommandSchema.parse({
              kind: "complete",
              revision,
              operationId: crypto.randomUUID(),
              turnId,
              checkpoint: btoa(binary),
              messages: displayHistory(),
              limited: conversationLimited,
            });
            return completion;
          },
          () => {
            status = outcomeStatus;
            error = outcomeError;
          },
        );
        await tick();
        if (!captured.signal.aborted) composer?.focus();
      }
    }
  }

  async function reset() {
    if (!canReset() || !saved || scope.signal.aborted) return;
    const current = agent;
    const input: ChatCommand = {
      kind: "reset",
      revision: saved.revision,
      operationId: crypto.randomUUID(),
    };
    // Retire the old conversation before awaiting close. Reset saves must finish
    // before initialization can expose a replacement engine and its tools.
    conversation.abort();
    conversation = new AbortController();
    scope = account.within(conversation.signal);
    const captured = scope;
    const previousApps = apps;
    apps = undefined;
    void previousApps?.close();
    agent = undefined;
    recovery = undefined;
    busy = true;
    error = "";
    status = "Starting a new conversation…";
    try {
      await current?.close();
    } catch (cause) {
      if (captured.signal.aborted) return;
      error = cause instanceof Error ? cause.message : "Unable to close the browser agent.";
    }
    if (captured.signal.aborted) return;
    const closeError = error;
    await persist(
      async () => input,
      async () => {
        messages = [];
        interrupted = false;
        followConversation = true;
        await initialize();
        if (!error) error = closeError;
      },
    );
  }

  async function discardUnfinished() {
    if (!canDiscard() || !saved?.pending) return;
    // Saving clears the error, but a failed startup still blocks chat and offers a retry.
    const startupError = agent ? "" : error;
    const input: ChatCommand = {
      kind: "discard",
      revision: saved.revision,
      operationId: crypto.randomUUID(),
      turnId: saved.pending.turnId,
    };
    await persist(
      async () => input,
      () => {
        if (saved) restoreMessages(saved);
        interrupted = false;
        error = startupError;
        status =
          "Unfinished turn discarded. No actions were replayed. Check your cart before continuing.";
      },
    );
  }

  return {
    get draft() {
      return prompt;
    },
    set draft(value) {
      prompt = value;
    },
    view: {
      get messages(): readonly Readonly<Entry>[] {
        return messages;
      },
      get status() {
        return status;
      },
      get error() {
        return error;
      },
      get busy() {
        return busy;
      },
      get initializing() {
        return initializing;
      },
      get interrupted() {
        return interrupted;
      },
      get historyBlocked() {
        return historyBlocked;
      },
      get hasRecovery() {
        return Boolean(recovery);
      },
      get showRetryLoading() {
        return !agent && !busy && !recovery && !historyBlocked && Boolean(error);
      },
      get canSend() {
        return canSend();
      },
      get canReset() {
        return canReset();
      },
      get canDiscard() {
        return canDiscard();
      },
    },
    actions: {
      submit: send,
      stop() {
        stopRequested = true;
        activeTurn?.cancel();
      },
      reset,
      discardUnfinished,
      async retrySave() {
        await recovery?.retry();
      },
      retryLoading() {
        error = "";
        void initialize();
      },
    },
    dom: {
      get composer() {
        return composer;
      },
      set composer(value) {
        composer = value;
      },
      get conversation() {
        return log;
      },
      set conversation(value) {
        log = value;
      },
      onScroll() {
        followConversation = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      },
    },
  };
}
