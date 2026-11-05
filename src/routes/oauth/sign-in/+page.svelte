<script lang="ts">
  import AccountForm from "$lib/components/AccountForm.svelte";
  import { z } from "zod";
  const continuation = z.object({ url: z.string() });
  async function continueAuthorization() {
    const response = await fetch("/api/auth/oauth2/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauth_query: location.search.slice(1), selected: true }),
    });
    if (!response.ok) throw new Error("Authorization expired. Connect your host again.");
    const result = continuation.parse(await response.json());
    location.assign(result.url);
  }
</script>

<AccountForm onAuthenticated={continueAuthorization} />
