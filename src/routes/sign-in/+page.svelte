<script lang="ts">
  import { goto } from "$app/navigation";
  import AccountForm from "$lib/components/AccountForm.svelte";
</script>

<AccountForm onAuthenticated={() => goto("/", { invalidateAll: true })} />
