<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Message from "$lib/components/ui/message";
  import * as Bubble from "$lib/components/ui/bubble";
  import McpAppCard from "./McpAppCard.svelte";
  import { createChatController } from "$lib/chat-controller.svelte";
  import type { Shop } from "$lib/shop";

  let {
    shop,
    webmcpError,
    model = $bindable(""),
    ready = $bindable(false),
  }: {
    shop: Shop;
    webmcpError: string;
    model?: string;
    ready?: boolean;
  } = $props();
  const chat = createChatController({
    get shop() {
      return shop;
    },
    get model() {
      return model;
    },
    set model(value) {
      model = value;
    },
    get ready() {
      return ready;
    },
    set ready(value) {
      ready = value;
    },
  });
</script>

<div
  bind:this={chat.dom.conversation}
  class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto rounded-xl border p-4"
  role="log"
  aria-label="Conversation"
  onscroll={chat.dom.onScroll}
>
  {#if !chat.view.messages.length}
    <div class="my-auto text-center">
      <h2 class="text-lg font-medium">Start a conversation</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        Ask about the shop, or add something to your cart.
      </p>
    </div>
  {/if}
  {#each chat.view.messages as message (message.id)}
    {#if message.kind === "app"}
      <McpAppCard view={message.view} apps={message.apps} />
    {:else if message.kind === "historical-app"}
      <section class="rounded-xl border p-4 text-xs text-muted-foreground" aria-label="Saved app">
        <p>{message.title}</p>
        <p>Saved app entry. Ask to open a fresh card; previous actions are not replayed.</p>
      </section>
    {:else}
      <Message.Root align={message.role === "user" ? "end" : "start"}>
        <Message.Content>
          <Message.Header>{message.role === "user" ? "You" : "fx"}</Message.Header>
          <Bubble.Root
            variant={message.role === "user" ? "default" : "muted"}
            align={message.role === "user" ? "end" : "start"}
          >
            <Bubble.Content
              ><div class="typeset text-xs">
                <p class="whitespace-pre-wrap">{message.text || "Thinking…"}</p>
              </div></Bubble.Content
            >
          </Bubble.Root>
        </Message.Content>
      </Message.Root>
    {/if}
  {/each}
</div>
<footer class="space-y-3">
  <p class="text-sm text-muted-foreground" role="status">{chat.view.status}</p>
  {#if webmcpError}<p class="text-sm text-muted-foreground" role="status">{webmcpError}</p>{/if}
  {#if chat.view.error}<p class="text-sm text-destructive" role="alert">{chat.view.error}</p>{/if}
  {#if chat.view.interrupted}
    <p class="text-sm text-muted-foreground">
      The last turn did not finish saving. Cart actions may already have happened. Stop any other
      running tab, review your cart, then discard the unfinished turn to return to the last saved
      checkpoint.
    </p>
    <Button
      type="button"
      variant="outline"
      onclick={chat.actions.discardUnfinished}
      disabled={!chat.view.canDiscard}>Discard unfinished turn</Button
    >
  {/if}
  {#if chat.view.hasRecovery}<Button
      type="button"
      variant="outline"
      onclick={chat.actions.retrySave}
      disabled={chat.view.busy}>Retry save</Button
    >{/if}
  {#if chat.view.historyBlocked}<Button
      type="button"
      variant="outline"
      onclick={() => location.reload()}>Reload saved chat</Button
    >{/if}
  {#if chat.view.showRetryLoading}<Button
      type="button"
      variant="outline"
      disabled={chat.view.initializing}
      onclick={chat.actions.retryLoading}>Retry loading chat</Button
    >{/if}
  <form onsubmit={chat.actions.submit} class="space-y-3">
    <label for="prompt" class="text-sm font-medium">Message</label>
    <Textarea
      class="text-sm"
      bind:ref={chat.dom.composer}
      bind:value={chat.draft}
      id="prompt"
      rows={3}
      maxlength={2000}
      required
      placeholder="What would you like to explore?"
      disabled={!chat.view.canSend}
      onkeydown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          chat.dom.composer?.form?.requestSubmit();
        }
      }}
    />
    <div class="flex flex-wrap items-center justify-between gap-2">
      <Button
        type="button"
        variant="ghost"
        onclick={chat.actions.reset}
        disabled={!chat.view.canReset}>New conversation</Button
      >
      <div class="ml-auto flex items-center gap-2">
        {#if chat.view.busy}<Button type="button" variant="outline" onclick={chat.actions.stop}
            >Stop reply</Button
          >{/if}
        <Button type="submit" disabled={!chat.view.canSend || !chat.draft.trim()}
          >Send message</Button
        >
      </div>
    </div>
  </form>
</footer>
