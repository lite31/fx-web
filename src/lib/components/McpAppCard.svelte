<script lang="ts">
  import { onMount } from "svelte";
  import type { HostView } from "$lib/contract";
  import type { McpApps } from "$lib/mcp-apps";
  let { view, apps }: { view: HostView; apps: McpApps } = $props();
  let container: HTMLDivElement;
  let error = $state("");
  let link = $state("");
  onMount(() => {
    try {
      return apps.mount(
        view,
        container,
        (message) => {
          error = message;
        },
        (url) => {
          link = url;
        },
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Unable to display the app.";
    }
  });
</script>

<section class="w-full shrink-0 overflow-hidden rounded-xl border" aria-label={view.title}>
  <h3 class="border-b px-4 py-2 text-sm font-medium">{view.title}</h3>
  <div bind:this={container}></div>
  {#if error}<p class="px-4 py-2 text-sm text-destructive" role="alert">{error}</p>{/if}
  {#if link}<a
      class="m-4 inline-block underline"
      href={link}
      target="_blank"
      rel="noopener noreferrer">Open shop checkout</a
    >{/if}
</section>
