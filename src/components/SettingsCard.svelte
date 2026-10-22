<script lang="ts">
  let {
    title,
    open = $bindable(false),
    children,
  }: { title: string; open?: boolean; children?: any } = $props();
</script>

<details class="settings-card" bind:open>
  <summary class="settings-card-header">{title}</summary>
  <div class="settings-card-body">
    {@render children?.()}
  </div>
</details>

<style>
  .settings-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .settings-card-header {
    cursor: pointer; list-style: none;
    padding: 10px 12px; font-size: 13px; font-weight: 600; color: var(--text);
  }
  .settings-card-header::-webkit-details-marker { display: none; }
  .settings-card-header::before { content: "▸ "; color: var(--muted); }
  .settings-card[open] .settings-card-header::before { content: "▾ "; }
  .settings-card-body {
    display: grid; gap: 8px; padding: 0 12px 12px;
  }
</style>
