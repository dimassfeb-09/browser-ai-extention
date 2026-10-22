<script lang="ts">
  function formatTime(ts: number) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return timeStr;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
  }
  import type { ChatSession, ChatState } from '../core/types';

  let {
    open = false,
    history = [],
    filteredHistory = [],
    historyGroups = [],
    historyQuery = $bindable(''),
    currentId = null,
    running = false,
    tabId = -1,
    byTab = {},
    deletingIds = new Set<string>(),
    onClose,
    onNewChat,
    onOpenSession,
    onDeleteSession,
    onClearAll,
  }: {
    open?: boolean;
    history?: ChatSession[];
    filteredHistory?: ChatSession[];
    historyGroups?: [string, ChatSession[]][];
    historyQuery?: string;
    currentId?: string | null;
    running?: boolean;
    tabId?: number;
    byTab?: Record<number, string>;
    deletingIds?: Set<string>;
    onClose?: () => void;
    onNewChat?: () => void;
    onOpenSession?: (id: string) => void;
    onDeleteSession?: (id: string) => void;
    onClearAll?: () => void;
  } = $props();
</script>

<div id="historyBackdrop" class="drawer-backdrop" class:open onclick={() => onClose?.()} role="presentation"></div>
<div id="historyDrawer" class="history-drawer" class:open data-testid="history">
  <div class="drawer-header">
    <div class="drawer-title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Chats
    </div>
    <button class="icon-btn" title="Close" onclick={() => onClose?.()}>✕</button>
  </div>

  <button class="drawer-new-chat-btn" onclick={() => onNewChat?.()}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New chat
  </button>

  <div class="history-search">
    <input type="text" placeholder="Search chats…" bind:value={historyQuery} aria-label="Search chats" />
  </div>

  <div id="sessionList" class="drawer-list">
    {#if filteredHistory.length === 0}
      <div class="drawer-empty">{history.length === 0 ? 'No chats yet.' : 'No chats match.'}</div>
    {:else}
      {#each historyGroups as [label, items] (label)}
        <div class="history-group">
          <div class="history-group-label">{label}</div>
          {#each items as s (s.id)}
            <div class="session-item" class:active={currentId === s.id} class:erasing={deletingIds.has(s.id)}>
              <button class="open" onclick={() => onOpenSession?.(s.id)}>
                <div class="session-title">{s.title}</div>
                <div class="session-meta">{running && currentId === s.id ? '⚡ Running... · ' : ''}{s.messages.length} {s.messages.length === 1 ? 'message' : 'messages'} · {formatTime(s.updatedAt)}{byTab[tabId] === s.id ? ' · this tab' : ''}</div>
              </button>
              <button class="session-del-btn" title="Delete chat" disabled={deletingIds.has(s.id)} onclick={() => onDeleteSession?.(s.id)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>

  <div class="drawer-footer">
    <button id="clearAllHistoryBtn" class="clear-all-btn" onclick={() => onClearAll?.()}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Clear all history
    </button>
  </div>
</div>

<style>
  .drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 30; }
  .drawer-backdrop.open { opacity: 1; pointer-events: auto; }
  .history-drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 280px; max-width: 82vw; background: var(--surface); border-right: 1px solid var(--border); transform: translateX(-100%); transition: transform .2s; z-index: 31; display: flex; flex-direction: column; gap: 8px; padding: 12px; overflow: auto; }
  .history-drawer.open { transform: translateX(0); }
  .drawer-header { display: flex; align-items: center; justify-content: space-between; }
  .drawer-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .drawer-new-chat-btn { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; font-size: 13px; }
  .history-search input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 13px; }
  .drawer-list { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
  .drawer-empty { padding: 20px; text-align: center; color: var(--muted); font-size: 13px; }
  .history-group { display: flex; flex-direction: column; gap: 4px; }
  .history-group-label { font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 4px 2px; }
  .session-item { display: flex; align-items: center; gap: 6px; border-radius: 8px; }
  .session-item.active { background: var(--surface-2); }
  .session-item.erasing { animation: smoke 520ms ease-out forwards; }
  @keyframes smoke { 0% { opacity: 1; transform: translateX(0); } 100% { opacity: 0; transform: translateX(-20px); filter: blur(4px); } }
  .session-item .open { flex: 1; text-align: left; padding: 8px 10px; border: none; background: transparent; color: var(--text); cursor: pointer; }
  .session-title { font-size: 13px; font-weight: 500; }
  .session-meta { font-size: 11px; color: var(--muted); }
  .session-del-btn { opacity: 0; border: none; background: transparent; color: var(--muted); cursor: pointer; padding: 6px; border-radius: 6px; }
  .session-item:hover .session-del-btn { opacity: 1; }
  .session-del-btn:hover { background: var(--danger-soft); color: var(--danger); }
  .drawer-footer { border-top: 1px solid var(--border); padding-top: 8px; }
  .clear-all-btn { width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--danger); font-size: 12.5px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .clear-all-btn:hover { background: var(--danger-soft); }
  .icon-btn { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 8px; padding: 6px 8px; cursor: pointer; }
</style>
