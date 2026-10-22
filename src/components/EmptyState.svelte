<script lang="ts">
  let {
    prompt = '',
    onDraft,
  }: { prompt?: string; onDraft?: (text: string) => void } = $props();
</script>

<div class="empty-state">
  <div class="empty-icon">A</div>
  <div class="empty-title visually-hidden">No messages yet</div>
  <div class="empty-greeting">How can I help you today?</div>
  <div class="empty-rotate" aria-live="polite">{prompt}</div>
  <div class="empty-chips">
    <button class="empty-chip" type="button" onclick={() => onDraft?.('Isi form ini dengan data contoh dan simpan')}>Fill a form</button>
    <button class="empty-chip" type="button" onclick={() => onDraft?.('Cari data berdasarkan nama/email lalu tampilkan detailnya')}>Search a record</button>
    <button class="empty-chip" type="button" onclick={() => onDraft?.('Ringkas data yang sedang tampil di halaman ini')}>Summarize page</button>
  </div>
  <div class="empty-text">Write a goal for the active tab below and press Send.</div>
</div>

<style>
  .empty-state { display: grid; gap: 10px; place-items: center; text-align: center; padding: 24px 8px; }
  .empty-icon { width: 40px; height: 40px; border-radius: 50%; background: var(--surface-2); color: var(--accent); display: grid; place-items: center; font-weight: 700; }
  .empty-greeting { font-size: 16px; font-weight: 600; color: var(--text); }
  .empty-rotate { font-size: 13px; color: var(--muted); min-height: 18px; }
  .empty-chips { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .empty-chip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  .empty-text { font-size: 12px; color: var(--muted); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
</style>
