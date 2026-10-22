<script lang="ts">
  let {
    open = false,
    title = '',
    message = '',
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    danger = true,
    onConfirm,
    onCancel,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
  } = $props();
</script>

{#if open}
  <div class="confirm-backdrop" role="presentation" onclick={() => onCancel?.()}>
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" onclick={(e) => e.stopPropagation()}>
      <h3 id="confirmTitle">{title}</h3>
      <p>{message}</p>
      <div class="confirm-actions">
        <button class="btn-ghost" type="button" onclick={() => onCancel?.()}>{cancelLabel}</button>
        <button class={danger ? 'btn-danger' : 'btn primary'} type="button" onclick={() => onConfirm?.()}>{confirmLabel}</button>
      </div>
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
  .btn-ghost, .btn-danger, .btn.primary {
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px;
    font-size: 13px; cursor: pointer;
  }
  .btn-ghost { background: var(--surface-2); color: var(--text); }
  .btn-danger { background: var(--danger); color: #fff; border-color: var(--danger); }
  .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
