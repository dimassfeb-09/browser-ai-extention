<script lang="ts">
  let {
    id = '',
    testId = '',
    options = [],
    value = $bindable(''),
    placeholder = 'Search…',
    disabled = false,
  }: {
    id?: string;
    testId?: string;
    options?: string[];
    value?: string;
    placeholder?: string;
    disabled?: boolean;
  } = $props();

  let query = $state('');
  let open = $state(false);

  const filtered = $derived(
    query.trim()
      ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
      : options
  );

  function choose(v: string) {
    value = v;
    query = v;
    open = false;
  }

  $effect(() => {
    if (!open) query = value ?? '';
  });
</script>

<div class="searchable-select">
  <input
    class="ss-input"
    type="text"
    {placeholder}
    bind:value={query}
    onfocus={() => (open = true)}
    onblur={() => setTimeout(() => (open = false), 120)}
    {disabled}
  />
  {#if open && filtered.length}
    <ul class="ss-list">
      {#each filtered as opt (opt)}
        <li>
          <button type="button" class="ss-option" class:active={opt === value} onclick={() => choose(opt)}>{opt}</button>
        </li>
      {/each}
    </ul>
  {/if}
  <!-- Hidden native select for E2E compatibility -->
  <select {id} data-testid={testId} bind:value={value} class="ss-native" aria-hidden="true" tabindex="-1">
    {#if !options.includes(value)}
      <option value={value}>{value} (current)</option>
    {/if}
    {#each options as o (o)}
      <option value={o}>{o}</option>
    {/each}
  </select>
</div>

<style>
  .searchable-select { position: relative; flex: 1; min-width: 0; z-index: 1; }
  .ss-input { width: 100%; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; color: var(--text); background: var(--bg); outline: none; }
  .ss-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .ss-list { position: absolute; z-index: 5; left: 0; right: 0; top: 100%; margin-top: 4px; max-height: 180px; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; list-style: none; padding: 4px 0; box-shadow: 0 8px 24px rgba(0,0,0,.2); }
  .ss-option { width: 100%; text-align: left; padding: 6px 10px; border: none; background: transparent; color: var(--text); font-size: 13px; cursor: pointer; }
  .ss-option:hover, .ss-option.active { background: var(--surface-2); }
  .ss-native { position: absolute; opacity: 0; pointer-events: none; width: 0 !important; height: 0 !important; }
</style>
