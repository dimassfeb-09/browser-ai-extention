<script lang="ts">
  let {
    open = false,
    title = '',
    message = '',
    onAllow,
    onBypass,
    onDeny,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    onAllow?: () => void;
    onBypass?: () => void;
    onDeny?: () => void;
  } = $props();
</script>

{#if open}
  <div class="confirm-backdrop" role="presentation" onclick={() => onDeny?.()}>
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="actionApprovalTitle" onclick={(e) => e.stopPropagation()}>
      <h3 id="actionApprovalTitle">{title}</h3>
      <p>{message}</p>
      <div class="confirm-actions">
        <button class="btn-ghost" type="button" onclick={() => onDeny?.()}>Deny</button>
        <button class="btn-ghost" type="button" onclick={() => onBypass?.()}>Bypass</button>
        <button class="btn primary" type="button" onclick={() => onAllow?.()}>Allow</button>
      </div>
      <div class="approval-hint">Bypass: jalankan aksi langsung untuk run ini (tidak disimpan).</div>
    </div>
  </div>
{/if}

<style>
  .confirm-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.65);
    display: flex; align-items: center; justify-content: center;
    z-index: 50; padding: 18px; backdrop-filter: blur(3px);
  }
  .confirm-dialog {
    width: 100%; max-width: 360px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; display: grid; gap: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,.22);
  }
  .confirm-dialog h3 { font-size: 15px; font-weight: 600; margin: 0; }
  .confirm-dialog p { font-size: 13px; color: var(--muted); margin: 0; white-space: pre-wrap; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .btn-ghost, .btn.primary {
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px;
    font-size: 13px; cursor: pointer;
  }
  .btn-ghost { background: var(--surface-2); color: var(--text); }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .approval-hint { font-size: 11px; color: var(--muted); line-height: 1.35; }
</style>
