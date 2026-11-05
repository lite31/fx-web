<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { z } from "zod";
  let scopes = $state<string[]>([]);
  let client = $state("Connected MCP host");
  let busy = $state(false);
  let error = $state("");
  onMount(() => {
    const query = new URLSearchParams(location.search);
    scopes = (query.get("scope") || "").split(" ").filter(Boolean);
    void fetch(
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(query.get("client_id") || "")}`,
    )
      .then(async (response) => {
        if (!response.ok) return;
        const parsed = z
          .object({ client_name: z.string().optional() })
          .safeParse(await response.json());
        if (parsed.success && parsed.data.client_name) client = parsed.data.client_name;
      })
      .catch(() => {});
  });
  async function consent(accept: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
      });
      if (!response.ok)
        throw new Error("Authorization expired. Sign in and connect your host again.");
      const result = z.object({ url: z.string() }).parse(await response.json());
      location.assign(result.url);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Unable to authorize this host.";
      busy = false;
    }
  }
</script>

<svelte:head><title>Authorize shop access · fx-web</title></svelte:head>
<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-8">
  <h1 class="text-xl font-semibold">Authorize {client}</h1>
  <p class="text-sm text-muted-foreground">Allow this host to use your signed-in shop session.</p>
  <ul class="space-y-2 text-sm">
    {#each scopes as scope}
      <li>
        {scope === "shop:read"
          ? "Read products and your cart."
          : scope === "shop:write"
            ? "Change your cart quantities."
            : scope === "offline_access"
              ? "Renew this authorization while your session remains active."
              : scope}
      </li>
    {/each}
  </ul>
  <p class="text-sm text-muted-foreground">
    To place an order, use Review order and Confirm order in the shop. Signing out of this session
    ends the host's access. Revoking a refresh token stops renewal. Access tokens already issued
    expire within five minutes.
  </p>
  {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
  <div class="flex gap-3">
    <Button disabled={busy} onclick={() => consent(true)}>Allow access</Button>
    <Button variant="outline" disabled={busy} onclick={() => consent(false)}>Deny</Button>
  </div>
</main>
