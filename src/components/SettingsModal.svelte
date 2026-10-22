<script lang="ts">
  let connectionOpen = $state(true);
  let advancedOpen = $state(false);
  import SettingsCard from './SettingsCard.svelte';
  import SearchableSelect from './SearchableSelect.svelte';
  import type { Settings } from '../core/types';

  let {
    open = $bindable(false),
    settings = $bindable<Settings>(),
    models = [],
    modelsLoading = false,
    modelsError = '',
    onSave,
    onLoadModels,
    onClose,
  }: {
    open?: boolean;
    settings?: Settings;
    models?: string[];
    modelsLoading?: boolean;
    modelsError?: string;
    onSave?: () => void;
    onLoadModels?: () => void;
    onClose?: () => void;
  } = $props();
</script>

{#if open}
  <div id="settingsModal" class="modal" class:open onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }} role="presentation">
    <div class="modal-card">
      <div class="modal-header">
        <div>
          <div class="modal-title">AI Configuration</div>
        <div class="modal-note">OpenAI Completions.</div>
        </div>
        <button class="icon-btn" type="button" aria-label="Close settings" onclick={() => onClose?.()}>✕</button>
      </div>

      <div class="settings-card">
        <button class="settings-card-header toggle" type="button" onclick={() => (connectionOpen = !connectionOpen)}>
          <svg class="chev" class:open={connectionOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          Connection
        </button>
        {#if connectionOpen}
          <div class="settings-card-body">
            <label class="field">
              <span>Base URL</span>
              <input type="text" bind:value={settings.baseURL} placeholder="https://.../v1beta/openai" />
            </label>
            <label class="field">
              <span>API Key</span>
              <input type="password" bind:value={settings.apiKey} placeholder="sk-..." autocomplete="off" />
            </label>
            <label class="field">
              <span>Model</span>
              <div class="input-row">
                <SearchableSelect id="modelSelect" testId="models" options={models} bind:value={settings.model} placeholder="Search model…" />
                <button class="icon-btn" type="button" title="Load models from endpoint" onclick={() => onLoadModels?.()} disabled={modelsLoading}>
                  {#if modelsLoading}
                    …
                  {:else}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>
                  {/if}
                </button>
              </div>
            </label>
            {#if modelsError}
              <p class="status">{modelsError}</p>
            {/if}
          </div>
        {/if}
      </div>

      <div class="settings-card">
        <button class="settings-card-header toggle" type="button" onclick={() => (advancedOpen = !advancedOpen)}>
          <svg class="chev" class:open={advancedOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          Advanced
        </button>
        {#if advancedOpen}
          <div class="settings-card-body">
            <label class="field">
              <span>Max steps per run (0 = no limit)</span>
              <input type="number" bind:value={settings.maxSteps} min="0" step="1" />
            </label>
            <label class="field">
              <span>Mode</span>
              <select bind:value={settings.actionGuardrailsBypass} onchange={(e) => {
                const bypass = (e.currentTarget as HTMLSelectElement).value === 'true';
                settings.actionGuardrailsBypass = bypass;
                settings.actionGuardrails = true;
              }}>
                <option value={false}>Guardrails (ask approval)</option>
                <option value={true}>Bypass (run direct)</option>
              </select>

            </label>
          </div>
        {/if}
      </div>

      <div class="modal-actions">
        <button class="btn primary" onclick={() => onSave?.()}>Save settings</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 40; padding: 18px; backdrop-filter: blur(8px); }
  .modal-card { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; display: grid; gap: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.22); }
  .modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .modal-title { font-size: 16px; font-weight: 600; margin-bottom: 2px; }
  .modal-subtitle { font-size: 11.5px; color: var(--muted); line-height: 1.35; }
  .modal-note { font-size: 10.5px; color: var(--muted); margin-top: 2px; }
  .chev { transition: transform .15s; margin-right: 6px; vertical-align: middle; }
  .chev.open { transform: rotate(180deg); }
  .modal-actions { display: flex; gap: 8px; margin-top: 4px; }
  .settings-card { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); overflow: visible; }
  .settings-card-header.toggle { width: 100%; text-align: left; cursor: pointer; padding: 10px 12px; font-size: 13px; font-weight: 600; color: var(--text); border: none; background: transparent; }
  .settings-card-body { display: grid; gap: 8px; padding: 0 12px 12px; }
  .chev { color: var(--muted); margin-right: 6px; }
  .field { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
  .field span { font-weight: 500; color: var(--text); }
  .input-row { display: flex; gap: 10px; align-items: center; flex-wrap: nowrap; }
  .input-row input, .input-row select { flex: 1; }
  .input-row .icon-btn { flex: 0 0 auto; width: auto; margin-left: 16px; padding: 8px 10px; white-space: nowrap; position: relative; z-index: 5; }
  .field.checkbox { flex-direction: row; align-items: center; gap: 8px; flex-wrap: wrap; }
  .field.checkbox input { width: 16px; height: 16px; }
  .field-hint { width: 100%; margin-left: 24px; font-size: 10.5px; color: var(--muted); }
  .modal-card input, .modal-card select { box-sizing: border-box; width: 100%; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; color: var(--text); background: var(--bg); outline: none; font-family: inherit; transition: border-color .15s, box-shadow .15s; }
  .modal-card input:focus, .modal-card select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .status { font-size: 12px; color: var(--muted); }
  .icon-btn { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 8px; padding: 6px 8px; cursor: pointer; }
  .btn.primary { background: var(--accent); color: #fff; border: 1px solid var(--accent); border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
</style>
