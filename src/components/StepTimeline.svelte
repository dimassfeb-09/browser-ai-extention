<script lang="ts">
  import { describeAction } from '../core/agentLoop';
  import type { StepRecord } from '../core/types';

  let { records = [], steps = [] }: { records?: StepRecord[]; steps?: string[] } = $props();
</script>

{#if (records && records.length) || (steps && steps.length)}
  <details class="stream-details">
    <summary>Step timeline ({records?.length ?? steps?.length})</summary>
    {#if records && records.length}
      <ol class="step-timeline">
        {#each records as r (r.step)}
          <li class:failed={r.result && !r.result.ok}>
            <span class="step-index">{r.step}</span>
            <div class="step-line-body">
              <span class="step-action">{describeAction(r.action)}</span>
              {#if r.action.type === 'type'}
                <span class="step-payload">“{r.action.text.slice(0, 60)}”</span>
              {/if}
              {#if r.result}
                <span class="step-result {r.result.ok ? 'ok' : 'err'}">{r.result.message}</span>
              {:else}
                <span class="step-result pending">running…</span>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    {/if}
    {#if steps && steps.length}
      <pre class="stream-pre">{steps.join('\n')}</pre>
    {/if}
  </details>
{/if}

<style>
  .stream-details { margin-top: 6px; font-size: 12px; color: var(--muted); }
  .stream-details summary { cursor: pointer; user-select: none; padding: 4px 0; list-style: none; color: var(--muted); transition: color .15s; font-weight: 600; }
  .stream-details summary::-webkit-details-marker { display: none; }
  .stream-details summary::before { content: "▸ "; }
  .stream-details[open] summary::before { content: "▾ "; }
  .stream-details summary:hover { color: var(--text); }
  .stream-pre { margin-top: 6px; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); max-height: 160px; overflow: auto; white-space: pre-wrap; font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px; color: var(--muted); line-height: 1.45; }
  .step-timeline { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .step-timeline li { display: grid; grid-template-columns: 24px 1fr; gap: 8px; align-items: start; font-size: 11.5px; }
  .step-timeline li.failed { color: var(--danger); }
  .step-index { width: 22px; height: 22px; border-radius: 50%; background: var(--surface2); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .step-line-body { display: flex; flex-direction: column; gap: 2px; }
  .step-action { color: var(--text); font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.35; }
  .step-payload { color: var(--muted); font-style: italic; font-size: 11px; }
  .step-result { font-size: 11px; padding: 1px 0; line-height: 1.4; }
  .step-result.ok { color: var(--accent); }
  .step-result.err { color: var(--danger); }
  .step-result.pending { color: var(--muted); }
</style>
