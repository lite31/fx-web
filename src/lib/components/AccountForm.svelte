<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { authenticate } from "$lib/auth-client";

  let { onAuthenticated }: { onAuthenticated: () => Promise<void> } = $props();
  let username = $state("");
  let email = $state("");
  let password = $state("");
  let register = $state(false);
  let busy = $state(false);
  let error = $state("");
  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      await authenticate({ username, password, ...(register ? { email } : {}) }, register);
      await onAuthenticated();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Sign in failed. Try again.";
    } finally {
      password = "";
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{register ? "Create account" : "Sign in"} · fx-web</title>
  <meta name="description" content="Sign in to shop and chat with fx-web." />
</svelte:head>

<main class="mx-auto flex min-h-dvh max-w-md items-center px-4 py-8">
  <Card.Root class="w-full">
    <Card.Header>
      <Card.Title><h1>{register ? "Create an account" : "Sign in to fx-web"}</h1></Card.Title>
      <Card.Description>Shop and chat with your own account and cart.</Card.Description>
    </Card.Header>
    <Card.Content>
      <form onsubmit={signIn} class="space-y-4" aria-label="Account">
        <label class="block text-sm"
          >Username
          <input
            class="mt-1 block w-full rounded-md border bg-background px-3 py-2"
            bind:value={username}
            autocomplete="username"
            minlength="3"
            maxlength="64"
            required
            disabled={busy}
          />
        </label>
        {#if register}
          <label class="block text-sm"
            >Email
            <input
              class="mt-1 block w-full rounded-md border bg-background px-3 py-2"
              type="email"
              bind:value={email}
              autocomplete="email"
              maxlength="254"
              required
              disabled={busy}
            />
          </label>
        {/if}
        <label class="block text-sm"
          >Password
          <input
            class="mt-1 block w-full rounded-md border bg-background px-3 py-2"
            type="password"
            bind:value={password}
            autocomplete={register ? "new-password" : "current-password"}
            minlength="12"
            maxlength="128"
            required
            disabled={busy}
          />
        </label>
        <p class="text-xs text-muted-foreground">
          Use 3–64 letters, numbers, dots, underscores or hyphens and a password of 12–128
          characters.
        </p>
        {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
        {#if busy}<p role="status" class="text-sm text-muted-foreground">Signing in…</p>{/if}
        <Button type="submit" class="w-full" disabled={busy}
          >{register ? "Create account" : "Sign in"}</Button
        >
        <Button
          type="button"
          variant="ghost"
          class="w-full"
          disabled={busy}
          onclick={() => {
            register = !register;
            error = "";
            password = "";
          }}
        >
          {register ? "Use existing account" : "Create an account"}
        </Button>
      </form>
    </Card.Content>
  </Card.Root>
</main>
