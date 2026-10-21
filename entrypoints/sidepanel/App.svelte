<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    loadSettings,
    saveSettings,
    defaultSettings,
    type Settings,
  } from '../../src/adapters/chrome/settings';
  import { ChromeChatStore, getCurrentWindowId } from '../../src/adapters/chrome/chatStore';
  import { TabContentDriver } from '../../src/adapters/chrome/contentDriver';
  import { ChatCompletionsClient } from '../../src/adapters/openai/client';
  import { runAgent } from '../../src/core/agentLoop';
  import {
    activeSession,
    addMessage,
    emptyChatState,
    ensureWindowSession,
    removeSession,
    setActiveSession,
    sortedSessions,
    startNewSession,
    upsertSession,
  } from '../../src/core/chat';
  import type { ChatMessage, ChatState } from '../../src/core/types';

  const store = new ChromeChatStore();
  const uid = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);

  let settings = $state<Settings>({ ...defaultSettings });
  let chatState = $state<ChatState>(emptyChatState());
  let windowId = $state(-1);
  let draft = $state('');
  let running = $state(false);
  let showHistory = $state(false);
  let statusLine = $state('');
  let messagesEl: HTMLElement | undefined = $state();
  const signal = { aborted: false };

  let current = $derived(activeSession(chatState, windowId));
  let history = $derived(sortedSessions(chatState));

  async function persist() {
    await store.save($state.snapshot(chatState));
  }

  async function scrollToBottom() {
    await tick();
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  onMount(async () => {
    settings = await loadSettings();
    windowId = await getCurrentWindowId();
    const loaded = await store.load();
    chatState = ensureWindowSession(loaded, windowId, uid(), Date.now());
    await persist();
    await scrollToBottom();
  });

  async function newChat() {
    chatState = startNewSession(chatState, windowId, uid(), Date.now());
    showHistory = false;
    statusLine = '';
    await persist();
  }

  async function openSession(id: string) {
    chatState = setActiveSession(chatState, windowId, id);
    showHistory = false;
    statusLine = '';
    await persist();
    await scrollToBottom();
  }

  async function deleteSession(id: string) {
    chatState = removeSession(chatState, id);
    chatState = ensureWindowSession(chatState, windowId, uid(), Date.now());
    await persist();
  }

  async function send() {
    const goal = draft.trim();
    if (!goal || running) return;
    if (!settings.apiKey) {
      statusLine = 'Fill in your OpenAI API key in Settings first.';
      return;
    }
    if (!current) return;
    draft = '';
    statusLine = '';
    await saveSettings(settings);

    const now = Date.now();
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: goal, ts: now };
    const draftMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: 'Working on it…',
      ts: now,
      steps: [],
    };
    let session = addMessage(current, userMsg);
    session = addMessage(session, draftMsg);
    chatState = upsertSession(chatState, session);
    await persist();
    await scrollToBottom();

    running = true;
    signal.aborted = false;
    const steps: string[] = [];
    const driver = new TabContentDriver();
    const llm = new ChatCompletionsClient({
      apiKey: settings.apiKey,
      model: settings.model,
      baseURL: settings.baseURL,
    });
    try {
      const result = await runAgent(goal, {
        driver,
        llm,
        signal,
        logger: {
          log: (event, data) => {
            steps.push(`${event}: ${JSON.stringify(data ?? '')?.slice(0, 240) ?? ''}`);
            const live = activeSession(chatState, windowId);
            if (live) {
              const msgs = live.messages.map((m) =>
                m.id === draftMsg.id ? { ...m, steps: [...steps] } : m,
              );
              chatState = upsertSession(chatState, { ...live, messages: msgs });
              void scrollToBottom();
            }
          },
        },
      });
      const live = activeSession(chatState, windowId);
      if (live) {
        const msgs = live.messages.map((m) =>
          m.id === draftMsg.id
            ? { ...m, content: result.summary, status: result.status, steps: [...steps] }
            : m,
        );
        chatState = upsertSession(chatState, { ...live, messages: msgs });
        await persist();
      }
      statusLine = `${result.status} — ${result.summary}`;
    } catch (err) {
      statusLine = `error — ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      running = false;
      await scrollToBottom();
    }
  }

  function stop() {
    signal.aborted = true;
  }

  function fmtDate(ts: number) {
    return new Date(ts).toLocaleString();
  }
</script>

<main>
  <header>
    <button class="icon" title="Chat history" onclick={() => (showHistory = !showHistory)}>☰</button>
    <strong class="title">{current?.title ?? 'Web Automation Agent'}</strong>
    <button class="icon" title="New chat" onclick={newChat}>＋</button>
  </header>

  {#if showHistory}
    <section class="card history" data-testid="history">
      <h2>History</h2>
      {#if history.length === 0}
        <p class="muted">No chats yet.</p>
      {:else}
        <ul>
          {#each history as s (s.id)}
            <li class:active={current?.id === s.id}>
              <button class="open" onclick={() => openSession(s.id)}>
                <span class="s-title">{s.title}</span>
                <span class="s-meta">{fmtDate(s.updatedAt)}{s.windowId === windowId ? ' · this window' : ''}</span>
              </button>
              <button class="icon del" title="Delete chat" onclick={() => deleteSession(s.id)}>✕</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <details class="card settings">
    <summary>Settings</summary>
    <label>
      OpenAI API key (BYOK, stored locally)
      <input type="password" bind:value={settings.apiKey} placeholder="sk-…" autocomplete="off" />
    </label>
    <label>
      Model
      <input type="text" bind:value={settings.model} />
    </label>
    <label>
      Base URL
      <input type="text" bind:value={settings.baseURL} />
    </label>
  </details>

  <section class="messages" data-testid="messages" bind:this={messagesEl}>
    {#if !current || current.messages.length === 0}
      <p class="muted empty">No messages yet. Write a goal for the active tab below.</p>
    {:else}
      {#each current.messages as m (m.id)}
        <div class="msg {m.role}">
          <p class="content">{m.content}</p>
          {#if m.status}<span class="chip">{m.status}</span>{/if}
          {#if m.steps && m.steps.length > 0}
            <details>
              <summary>Steps ({m.steps.length})</summary>
              <ol>
                {#each m.steps as line}
                  <li><code>{line}</code></li>
                {/each}
              </ol>
            </details>
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  {#if statusLine}<p class="status">{statusLine}</p>{/if}

  <footer class="composer">
    <textarea
      bind:value={draft}
      rows="2"
      placeholder="Message / goal for the active tab…"
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void send();
        }
      }}
    ></textarea>
    {#if running}
      <button onclick={stop}>Stop</button>
    {:else}
      <button class="primary" onclick={send}>Send</button>
    {/if}
  </footer>
</main>

<style>
  main { font-family: system-ui, sans-serif; padding: 10px; display: grid; gap: 10px; }
  header { display: flex; align-items: center; gap: 8px; }
  header .title { flex: 1; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { padding: 7px 10px; border-radius: 6px; border: 1px solid #bbb; cursor: pointer; background: #fff; }
  button.icon { padding: 5px 9px; }
  button.primary { background: #111; color: #fff; border-color: #111; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 10px; display: grid; gap: 8px; }
  .card h2 { font-size: 13px; margin: 0; }
  label { display: grid; gap: 4px; font-size: 12px; }
  input, textarea { font: inherit; padding: 6px; border: 1px solid #bbb; border-radius: 6px; }
  summary { cursor: pointer; font-size: 12px; }
  .history ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .history li { display: flex; gap: 6px; align-items: stretch; border-radius: 6px; }
  .history li.active { outline: 2px solid #111; }
  .history .open { flex: 1; text-align: left; display: grid; gap: 2px; border: none; background: #f6f6f6; }
  .history .s-title { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .history .s-meta { font-size: 11px; color: #777; }
  .messages { display: grid; gap: 8px; max-height: 55vh; overflow-y: auto; padding: 2px; }
  .msg { border-radius: 10px; padding: 8px 10px; max-width: 92%; display: grid; gap: 6px; }
  .msg.user { background: #111; color: #fff; justify-self: end; }
  .msg.assistant { background: #f1f1f1; justify-self: start; }
  .msg .content { margin: 0; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .msg .chip { font-size: 10px; background: #ddd; border-radius: 999px; padding: 1px 7px; width: fit-content; }
  .msg.user .chip { background: #333; color: #fff; }
  .msg details ol { margin: 4px 0 0; padding-left: 16px; display: grid; gap: 3px; }
  .msg code { font-size: 10.5px; word-break: break-word; }
  .status { font-size: 12px; margin: 0; }
  .muted { color: #777; font-size: 12px; margin: 0; }
  .composer { display: flex; gap: 8px; align-items: flex-end; }
  .composer textarea { flex: 1; }
</style>
