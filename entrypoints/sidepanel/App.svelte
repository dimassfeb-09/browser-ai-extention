<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    loadSettings,
    saveSettings,
    defaultSettings,
    type Settings,
  } from '../../src/adapters/chrome/settings';
  import {
    ChromeChatStore,
    getActiveTabId,
    getCurrentWindowId,
  } from '../../src/adapters/chrome/chatStore';
  import { TabContentDriver } from '../../src/adapters/chrome/contentDriver';
  import { ChatCompletionsClient } from '../../src/adapters/openai/client';
  import { runAgent } from '../../src/core/agentLoop';
  import {
    activeSession,
    addMessage,
    buildConversation,
    clearSession,
    emptyChatState,
    ensureTabSession,
    removeSession,
    setActiveSession,
    sortedSessions,
    startNewSession,
    upsertSession,
  } from '../../src/core/chat';
  import {
    formatHelp,
    matchSlashCommands,
    parseSlashCommand,
    type ParsedSlashCommand,
  } from '../../src/core/commands';
  import type { ChatMessage, ChatState } from '../../src/core/types';

  const store = new ChromeChatStore();
  const uid = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);

  let settings = $state<Settings>({ ...defaultSettings });
  let chatState = $state<ChatState>(emptyChatState());
  let windowId = $state(-1);
  /** Active tab of this window — the session binding key. The panel
   *  view follows it (see the onActivated listener in onMount). */
  let tabId = $state(-1);
  let draft = $state('');
  let running = $state(false);
  let showHistory = $state(false);
  let showSettings = $state(false);
  let models = $state<string[]>([]);
  let modelsLoading = $state(false);
  let modelsError = $state('');
  let compacting = $state(false);

  /** Commands matching what is being typed in the composer (shown as a
   *  suggestion menu while the draft is a bare '/…'). */
  let slashMatches = $derived(
    draft.trimStart().startsWith('/') && !draft.trim().includes(' ')
      ? matchSlashCommands(draft.trim())
      : [],
  );
  let messagesEl: HTMLElement | undefined = $state();
  const signal = { aborted: false };

  let current = $derived(activeSession(chatState, tabId));
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
    tabId = await getActiveTabId(windowId);
    const loaded = await store.load();
    chatState = ensureTabSession(loaded, windowId, tabId, uid(), Date.now());
    await persist();
    await scrollToBottom();
    // Follow the active tab: each tab has its own chat, and the panel
    // (visible only on tabs where it was enabled) shows the chat of
    // the tab the user is looking at. A run in progress keeps updating
    // its own session by id in the background.
    browser.tabs.onActivated.addListener((info) => {
      if (info.windowId !== windowId || info.tabId === tabId) return;
      tabId = info.tabId;
      chatState = ensureTabSession(chatState, windowId, tabId, uid(), Date.now());
      void persist();
      void scrollToBottom();
    });
  });

  async function newChat() {
    chatState = startNewSession(chatState, windowId, tabId, uid(), Date.now());
    showHistory = false;
    await persist();
  }

  async function openSession(id: string) {
    chatState = setActiveSession(chatState, tabId, id);
    showHistory = false;
    await persist();
    await scrollToBottom();
  }

  async function deleteSession(id: string) {
    chatState = removeSession(chatState, id);
    chatState = ensureTabSession(chatState, windowId, tabId, uid(), Date.now());
    await persist();
  }

  async function clearCurrentChat() {
    if (!current) return;
    chatState = upsertSession(chatState, clearSession(current, Date.now()));
    await persist();
    await scrollToBottom();
  }

  async function deleteCurrent() {
    if (!current) return;
    await deleteSession(current.id);
  }

  async function clearAllHistory() {
    chatState = ensureTabSession(emptyChatState(), windowId, tabId, uid(), Date.now());
    await persist();
    showHistory = false;
  }

  async function loadModels() {
    modelsLoading = true;
    modelsError = '';
    try {
      const base = settings.baseURL.trim().replace(/\/+$/, '');
      const res = await fetch(`${base}/models`, {
        headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = Array.isArray(json?.data)
        ? json.data.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      models = [...new Set(ids)].sort();
      if (models.length > 0 && !models.includes(settings.model)) {
        settings.model = models[0];
      }
      if (models.length === 0) modelsError = 'No models returned.';
    } catch (err) {
      modelsError = `Failed to load models: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      modelsLoading = false;
    }
  }

  async function saveSettingsNow() {
    await saveSettings(settings);
    showSettings = false;
  }

  /** Append a local UI notice to the chat (slash-command feedback).
   *  Local messages render like assistant bubbles but are never handed
   *  to the model as conversation history. */
  async function notice(text: string) {
    if (!current) return;
    const msg: ChatMessage = { id: uid(), role: 'assistant', content: text, ts: Date.now(), local: true };
    chatState = upsertSession(chatState, addMessage(current, msg));
    await persist();
    await scrollToBottom();
  }

  const COMPACT_SYSTEM = [
    'You compress conversation histories for a web-automation agent.',
    'Write a compact brief (max ~200 words, plain text) that preserves:',
    '- every goal the user gave, in order;',
    '- what the agent actually did and the concrete values it used or created (names, codes, amounts);',
    '- each outcome (done/failed/stuck) and any record identifiers;',
    '- anything still pending or explicitly promised.',
    'Drop filler and step-by-step detail. The agent will rely on this brief as its only memory of the folded turns.',
  ].join('\n');

  async function doCompact() {
    if (!current) return;
    if (!settings.apiKey) {
      showSettings = true;
      return;
    }
    if (compacting) return;
    const session = current;
    const cutoff = session.compactCutoff ?? 0;
    const folded = session.messages.filter((m) => m.ts > cutoff && !m.local);
    if (folded.length < 2) {
      await notice('Nothing to compact yet — this chat is still short. /compact folds older turns once a conversation has built up.');
      return;
    }
    compacting = true;
    try {
      const turns = buildConversation(session);
      const rendered = turns
        .map((t) => `${t.role === 'user' ? 'USER' : 'YOU'}: ${t.content}`)
        .join('\n');
      const llm = new ChatCompletionsClient({
        apiKey: settings.apiKey,
        model: settings.model,
        baseURL: settings.baseURL,
      });
      const summary = await llm.summarize(COMPACT_SYSTEM, rendered);
      const lastTs = Math.max(...session.messages.map((m) => m.ts));
      chatState = upsertSession(chatState, {
        ...session,
        compactSummary: summary,
        compactCutoff: lastTs,
        updatedAt: Date.now(),
      });
      await persist();
      await notice(
        `Compacted ${folded.length} messages into a summary. Future runs carry this brief instead of the full history:\n\n${summary}`,
      );
    } catch (err) {
      await notice(`Compact failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      compacting = false;
    }
  }

  function exportChat() {
    if (!current) return;
    const lines: string[] = [`# ${current.title}`, '', `Exported ${new Date().toLocaleString()}`, ''];
    for (const m of current.messages) {
      if (m.local) continue;
      lines.push(
        `## ${m.role === 'user' ? 'User' : 'Assistant'}${m.status ? ` (${m.status})` : ''} — ${new Date(m.ts).toLocaleString()}`,
        '',
        m.content,
        '',
      );
      if (m.steps?.length) lines.push(`Steps (${m.steps.length}):`, '', '```', ...m.steps, '```', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-${current.title.replace(/[^\w-]+/g, '-').slice(0, 40) || 'export'}.md`;
    a.click();
    URL.revokeObjectURL(url);
    void notice('Chat exported as a Markdown file.');
  }

  /** Slash commands run locally in the panel — they never reach the
   *  model as a goal. Everything except /stop and /help waits until no
   *  task is running. */
  async function runSlashCommand(cmd: ParsedSlashCommand) {
    if (running && cmd.name !== 'stop' && cmd.name !== 'help') {
      await notice('A task is running — /stop it first, then run the command.');
      return;
    }
    switch (cmd.name) {
      case 'help':
        await notice(formatHelp());
        break;
      case 'stop':
        if (running) {
          stop();
          await notice('Stopping the current run…');
        } else {
          await notice('Nothing is running right now.');
        }
        break;
      case 'new':
        await newChat();
        await notice('New chat started. Earlier chats live in History.');
        break;
      case 'reset':
      case 'clear': {
        if (!current) return;
        chatState = upsertSession(chatState, clearSession(current, Date.now()));
        await persist();
        await notice('Chat cleared — all messages and the agent memory for this chat are gone. The session itself stays in History.');
        break;
      }
      case 'compact':
        await doCompact();
        break;
      case 'retry': {
        const last = [...(current?.messages ?? [])]
          .reverse()
          .find((m) => m.role === 'user' && !m.local);
        if (!last) await notice('Nothing to retry yet — no goal has been sent in this chat.');
        else await send(last.content);
        break;
      }
      case 'model':
        if (!cmd.arg) {
          await notice(
            `Current model: ${settings.model}\nBase URL: ${settings.baseURL}\nMax steps per run: ${settings.maxSteps === 0 ? 'no limit' : settings.maxSteps}\n\nSwitch with /model <name> — applies from the next run.`,
          );
        } else {
          settings.model = cmd.arg;
          await saveSettings(settings);
          await notice(`Model switched to "${cmd.arg}". Applies from the next run.`);
        }
        break;
      case 'settings':
        showSettings = true;
        break;
      case 'export':
        exportChat();
        break;
    }
  }

  async function send(preset?: string) {
    const goal = (preset ?? draft).trim();
    if (!goal) return;
    if (goal.startsWith('/')) {
      const cmd = parseSlashCommand(goal);
      draft = '';
      if (!cmd || !cmd.known) {
        await notice(`Unknown command "${goal.split(' ')[0]}" — type /help for the list.`);
        return;
      }
      await runSlashCommand(cmd);
      return;
    }
    if (running) return;
    if (!settings.apiKey) {
      showSettings = true;
      return;
    }
    if (!current) return;
    draft = '';
    const conversation = buildConversation(current);
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
    // Pin the run to the tab that is active RIGHT NOW. Without a pinned
    // id the driver re-resolves "the active tab" on every step, so the
    // agent would follow the user to another tab mid-run and start
    // acting there. With the pin, the user can switch tabs/windows
    // freely; if the pinned tab is closed the run errors out instead of
    // jumping somewhere else.
    let targetTabId: number | undefined;
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      targetTabId = tab?.id;
    } catch {
      // Fall back to the driver's dynamic active-tab resolution.
    }
    const driver = new TabContentDriver(targetTabId);
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
        conversation,
        maxSteps: settings.maxSteps > 0 ? settings.maxSteps : 100_000,
        logger: {
          log: (event, data) => {
            steps.push(`${event}: ${JSON.stringify(data ?? '')?.slice(0, 240) ?? ''}`);
            const live = activeSession(chatState, tabId);
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
      const live = activeSession(chatState, tabId);
      if (live) {
        const msgs = live.messages.map((m) =>
          m.id === draftMsg.id
            ? { ...m, content: result.summary, status: result.status, steps: [...steps] }
            : m,
        );
        chatState = upsertSession(chatState, { ...live, messages: msgs });
        await persist();
      }
    } catch (err) {
      // No status bar above the composer: failures surface inside the
      // assistant bubble itself, like a normal chat reply.
      const message = err instanceof Error ? err.message : String(err);
      const live = activeSession(chatState, tabId);
      if (live) {
        const msgs = live.messages.map((m) =>
          m.id === draftMsg.id
            ? { ...m, content: `Error: ${message}`, status: 'error', steps: [...steps] }
            : m,
        );
        chatState = upsertSession(chatState, { ...live, messages: msgs });
        await persist();
      }
    } finally {
      running = false;
      await scrollToBottom();
    }
  }

  function stop() {
    signal.aborted = true;
  }

  async function popout() {
    try {
      const chromeAny = (globalThis as Record<string, any>)['chrome'];
      if (chromeAny?.windows?.create) {
        await chromeAny.windows.create({ url: chromeAny.runtime.getURL('sidepanel.html'), type: 'popup' });
      }
    } catch {
      // best-effort
    }
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (showSettings) showSettings = false;
    else if (showHistory) showHistory = false;
  }

  function formatTime(ts: number) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return timeStr;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<main>
  <div class="topbar">
    <div class="topbar-left">
      <button id="historyBtn" class="icon-btn" title="Chat history" aria-label="Chat history" onclick={() => (showHistory = !showHistory)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>
      </button>
      <div class="logo">A</div>
      <div class="header-info">
        <div class="title">{current?.title ?? 'Web Automation Agent'}</div>
        <div class="subtitle">Browser AI agent</div>
      </div>
    </div>
    <div class="topbar-right">
      <button id="newChatBtn" class="icon-btn" title="New chat" aria-label="New chat" onclick={newChat}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <button id="deleteChatBtn" class="icon-btn" title="Clear current chat" aria-label="Clear current chat" onclick={() => void clearCurrentChat()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
      <button id="popoutBtn" class="icon-btn" title="Open in separate window" aria-label="Open in separate window" onclick={popout}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>
      <button id="cfgBtn" class="icon-btn" title="AI Config" aria-label="AI Config" onclick={() => (showSettings = true)}>⚙</button>
    </div>
  </div>

  <div id="log" class="log" data-testid="messages" bind:this={messagesEl}>
    {#if !current || current.messages.length === 0}
      <div class="msg-row system">
        <p class="msg-text empty">No messages yet. Write a goal for the active tab below.</p>
      </div>
    {:else}
      {#each current.messages as m (m.id)}
        <div class="msg-row {m.role}">
          {#if m.role === 'assistant'}
            <div class="avatar assistant">A</div>
          {/if}
          <div class="msg-content">
            {#if m.role === 'user'}
              <div class="bubble">{m.content}</div>
            {:else}
              <div class="assistant-text">{m.content}</div>
              {#if m.status}<span class="chip">{m.status}</span>{/if}
              {#if m.steps && m.steps.length > 0}
                <details class="stream-details">
                  <summary>Steps ({m.steps.length})</summary>
                  <pre class="stream-pre">{m.steps.join('\n')}</pre>
                </details>
              {/if}
            {/if}
          </div>
          {#if m.role === 'user'}
            <div class="avatar user">U</div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <div class="inputbar">
    {#if slashMatches.length > 0}
      <div class="slash-menu" data-testid="slash-menu">
        {#each slashMatches as c}
          <button
            class="slash-item"
            onclick={() => {
              draft = c.takesArg ? `/${c.name} ` : `/${c.name}`;
              document.getElementById('input')?.focus();
            }}
          >
            <span class="slash-usage">{c.usage}</span>
            <span class="slash-desc">{c.description}</span>
          </button>
        {/each}
      </div>
    {/if}
    <div class="input-shell">
      <textarea
        id="input"
        bind:value={draft}
        rows="1"
        placeholder="Message AutoAgent..."
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      ></textarea>
      {#if running}
        <button id="cancel" aria-label="Cancel" onclick={stop}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span class="sr-only">Stop</span></button>
      {:else}
        <button id="send" aria-label="Send" onclick={() => void send()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg><span class="sr-only">Send</span></button>
      {/if}
    </div>
    <div class="input-hint">Enter to send · Shift+Enter for new line</div>
  </div>

  <div id="historyBackdrop" class="drawer-backdrop" class:open={showHistory} onclick={() => (showHistory = false)} role="presentation"></div>
  <div id="historyDrawer" class="history-drawer" class:open={showHistory} data-testid="history">
    <div class="drawer-header">
      <div class="drawer-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>
        History Chat
      </div>
      <button class="icon-btn" title="Close" onclick={() => (showHistory = false)}>✕</button>
    </div>

    <button class="drawer-new-chat-btn" onclick={newChat}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      + New Chat
    </button>

    <div id="sessionList" class="drawer-list">
      {#if history.length === 0}
        <div class="drawer-empty">No chats yet.</div>
      {:else}
        {#each history as s (s.id)}
          <div class="session-item" class:active={current?.id === s.id}>
            <button class="open" onclick={() => openSession(s.id)}>
              <div class="session-title">{s.title}</div>
              <div class="session-meta">{running && current?.id === s.id ? '⚡ Running... · ' : ''}{s.messages.length} {s.messages.length === 1 ? 'message' : 'messages'} · {formatTime(s.updatedAt)}{chatState.byTab[tabId] === s.id ? ' · this tab' : ''}</div>
            </button>
            <button class="session-del-btn" title="Delete chat" onclick={() => deleteSession(s.id)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        {/each}
      {/if}
    </div>

    <div class="drawer-footer">
      <button id="clearAllHistoryBtn" class="clear-all-btn" onclick={clearAllHistory}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Clear all history
      </button>
    </div>
  </div>

  <div id="settingsModal" class="modal" class:open={showSettings} onclick={(e) => { if (e.target === e.currentTarget) showSettings = false; }} role="presentation">
    <div class="modal-card">
      <div class="modal-title">AI Configuration</div>
      <label class="field">
        <span>API Key</span>
        <input type="password" bind:value={settings.apiKey} placeholder="sk-..." autocomplete="off" />
      </label>
      <label class="field">
        <span>Model</span>
        <div class="input-row">
          <input type="text" bind:value={settings.model} placeholder="gpt-4o-mini" />
          <button class="icon-btn" type="button" title="Load models from endpoint" onclick={() => void loadModels()} disabled={modelsLoading}>
            {modelsLoading ? '…' : '↻'}
          </button>
        </div>
      </label>
      <label class="field">
        <span>Available models</span>
        <select id="modelSelect" data-testid="models" bind:value={settings.model}>
          {#if !models.includes(settings.model)}
            <option value={settings.model}>{settings.model} (current)</option>
          {/if}
          {#each models as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
      </label>
      {#if modelsError}
        <p class="status">{modelsError}</p>
      {/if}
      <label class="field">
        <span>Base URL</span>
        <input type="text" bind:value={settings.baseURL} placeholder="https://.../v1beta/openai" />
      </label>
      <label class="field">
        <span>Max steps per run (0 = no limit)</span>
        <input type="number" bind:value={settings.maxSteps} min="0" step="1" />
      </label>
      <div class="modal-actions">
        <button class="btn primary" onclick={saveSettingsNow}>Save</button>
      </div>
    </div>
  </div>
</main>

<style>
  :global(:root) {
    --bg: #212121;
    --surface: #2f2f2f;
    --surface-2: #3a3a3a;
    --border: #424242;
    --text: #ececec;
    --muted: #9b9b9b;
    --accent: #10a37f;
    --accent-soft: rgba(16, 163, 127, 0.16);
    --danger: #ef4444;
    --danger-soft: rgba(239, 68, 68, 0.15);
    --radius: 18px;
    --radius-sm: 10px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  button { font: inherit; color: var(--text); background: transparent; border: 1px solid var(--border); cursor: pointer; }
  main {
    height: 100vh; width: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14.5px;
    color: var(--text);
    background: var(--bg);
    display: flex; flex-direction: column;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    position: relative;
  }

  .topbar {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }
  .topbar-left {
    display: flex; align-items: center; gap: 8px;
    min-width: 0; flex: 1;
  }
  .topbar-right {
    display: flex; align-items: center; gap: 6px;
    flex-shrink: 0;
  }
  .logo {
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 13px;
    flex-shrink: 0;
  }
  .header-info { min-width: 0; }
  .title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subtitle { font-size: 11px; color: var(--muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .icon-btn {
    width: 32px; height: 32px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: transparent;
    color: var(--muted); cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    transition: background .15s, color .15s, border-color .15s;
    flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--surface); color: var(--text); border-color: var(--muted); }
  .icon-btn:active { transform: scale(0.96); }

  .log {
    flex: 1; overflow-y: auto;
    padding: 12px 0 20px;
    display: flex; flex-direction: column;
    scroll-behavior: smooth;
  }
  .log::-webkit-scrollbar { width: 8px; }
  .log::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 4px; }
  .log::-webkit-scrollbar-track { background: transparent; }

  .msg-row { display: flex; gap: 14px; padding: 12px 14px; }
  .msg-row.user { justify-content: flex-end; align-items: center; }
  .msg-row.assistant { justify-content: flex-start; }
  .msg-row.system, .msg-row.error { justify-content: center; padding: 6px 18px; }

  .avatar {
    width: 28px; height: 28px; border-radius: 50%;
    flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700;
  }
  .avatar.assistant { background: var(--accent); color: #fff; }
  .avatar.user { background: var(--surface-2); color: var(--text); }

  .msg-content { flex: 1; min-width: 0; max-width: 88%; }
  .msg-row.user .bubble {
    background: var(--surface); color: var(--text);
    padding: 10px 16px; border-radius: var(--radius);
    border-bottom-right-radius: 4px;
    line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    display: flex; align-items: center; min-height: 28px;
    margin-left: auto;
  }
  .assistant-text {
    color: var(--text); line-height: 1.65;
    white-space: pre-wrap; word-break: break-word; letter-spacing: -0.005em;
  }
  .msg-text.system { color: var(--muted); font-size: 12px; text-align: center; }
  .msg-text.error { color: var(--danger); font-size: 12px; text-align: center; }

  .chip { font-size: 10px; background: #ddd; color: #111; border-radius: 999px; padding: 1px 7px; width: fit-content; margin-top: 4px; }
  .msg-row.user .chip { background: #333; color: #fff; }

  .stream-details {
    margin-top: 10px; font-size: 12px; color: var(--muted);
  }
  .stream-details summary {
    cursor: pointer; user-select: none; padding: 2px 0;
    list-style: none;
  }
  .stream-details summary::-webkit-details-marker { display: none; }
  .stream-details summary::before { content: "▸ "; }
  .stream-details[open] summary::before { content: "▾ "; }
  .stream-details summary:hover { color: var(--text); }
  .stream-pre {
    margin-top: 8px; padding: 10px 12px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); max-height: 150px; overflow: auto;
    white-space: pre-wrap; font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px; color: var(--muted); line-height: 1.45;
  }

  .status { font-size: 12px; margin: 0 14px 4px; color: var(--muted); }

  .inputbar {
    padding: 10px 14px 14px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }
  .slash-menu {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 8px;
    max-height: 220px;
    overflow-y: auto;
  }
  .slash-item {
    display: flex;
    gap: 10px;
    align-items: baseline;
    text-align: left;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .slash-item:hover {
    border-color: var(--accent);
  }
  .slash-usage {
    font-weight: 600;
    white-space: nowrap;
  }
  .slash-desc {
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .input-shell {
    display: flex; align-items: flex-end; gap: 10px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 26px; padding: 8px 10px 8px 16px;
    box-shadow: 0 8px 24px rgba(0,0,0,.18);
    transition: border-color .15s, box-shadow .15s, background .15s;
  }
  .input-shell:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  #input {
    flex: 1; border: none; background: transparent; color: var(--text);
    outline: none; resize: none; font: inherit; font-size: 14px;
    line-height: 1.5; max-height: 120px; padding: 6px 0;
  }
  #input::placeholder { color: var(--muted); }
  #send, #cancel {
    width: 36px; height: 36px; border-radius: 50%; border: none;
    color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: filter .15s, transform .08s;
  }
  #send { background: var(--accent); }
  #cancel { background: var(--danger); }
  #send:disabled { opacity: .45; cursor: default; }
  #send:hover:not(:disabled) { filter: brightness(1.08); }
  #send:active:not(:disabled) { transform: scale(.96); }
  #cancel:hover { filter: brightness(1.08); }
  #cancel:active { transform: scale(.96); }

  .input-hint { font-size: 11px; color: var(--muted); text-align: center; margin-top: 6px; }

  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

  .drawer-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.55);
    z-index: 30; opacity: 0; pointer-events: none;
    transition: opacity .2s ease;
  }
  .drawer-backdrop.open { opacity: 1; pointer-events: auto; }
  .history-drawer {
    position: fixed; top: 0; bottom: 0; left: 0;
    width: 320px; max-width: 86%;
    background: var(--surface); border-right: 1px solid var(--border);
    z-index: 31; transform: translateX(-100%);
    transition: transform .25s cubic-bezier(0.16, 1, 0.3, 1);
    display: flex; flex-direction: column;
    box-shadow: 10px 0 30px rgba(0,0,0,.5);
  }
  .history-drawer.open { transform: translateX(0); }

  .drawer-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
    background: var(--bg);
  }
  .drawer-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .drawer-actions { display: flex; align-items: center; gap: 6px; }

  .drawer-new-chat-btn {
    display: flex; align-items: center; gap: 8px;
    margin: 12px 14px 8px;
    padding: 10px 14px;
    background: var(--bg); border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text); font-size: 13px; font-weight: 500;
    cursor: pointer; transition: background .15s, border-color .15s;
  }
  .drawer-new-chat-btn:hover { background: var(--surface-2); border-color: var(--accent); color: var(--accent); }

  .drawer-list {
    flex: 1; overflow-y: auto; padding: 6px 10px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .drawer-list::-webkit-scrollbar { width: 6px; }
  .drawer-list::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 3px; }

  .session-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background .15s, border-color .15s;
    user-select: none;
  }
  .session-item:hover { background: var(--bg); border-color: var(--border); }
  .session-item.active {
    background: var(--bg);
    border-color: var(--accent);
  }
  .session-info { min-width: 0; flex: 1; margin-right: 8px; }
  .session-title {
    font-size: 13.5px; font-weight: 500; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .session-meta {
    font-size: 11px; color: var(--muted); margin-top: 3px;
    display: flex; align-items: center; gap: 6px;
  }
  .session-item .open {
    flex: 1; text-align: left; border: none; background: transparent;
    color: var(--text); cursor: pointer; padding: 0; margin: 0;
    display: grid; gap: 2px; font: inherit;
  }
  .session-item .open:hover { color: var(--text); }
  .session-del-btn {
    opacity: 0; width: 26px; height: 26px; border-radius: 6px;
    border: none; background: transparent; color: var(--muted);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: opacity .15s, color .15s, background .15s;
    flex-shrink: 0;
  }
  .session-item:hover .session-del-btn { opacity: 1; }
  .session-del-btn:hover { background: var(--danger-soft); color: var(--danger); }

  .drawer-empty {
    padding: 30px 16px; text-align: center; color: var(--muted); font-size: 13px;
  }

  .drawer-footer {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    display: flex; flex-direction: column; gap: 8px;
  }
  .clear-all-btn {
    width: 100%; padding: 8px 12px; border-radius: var(--radius-sm);
    border: 1px solid transparent; background: transparent;
    color: var(--danger); font-size: 12.5px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    transition: background .15s;
  }
  .clear-all-btn:hover { background: var(--danger-soft); }

  .modal {
    position: fixed; inset: 0; background: rgba(0,0,0,.55);
    display: none; align-items: center; justify-content: center;
    z-index: 40; padding: 18px;
  }
  .modal.open { display: flex; }
  .modal-card {
    width: 100%; max-width: 360px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 18px;
    display: grid; gap: 10px;
    box-shadow: 0 20px 60px rgba(0,0,0,.45);
  }
  .modal-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .modal-card input {
    width: 100%; padding: 10px 12px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-size: 13px; color: var(--text); background: var(--bg);
    outline: none; font-family: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  .modal-card input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .modal-card select {
    width: 100%; padding: 10px 12px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-size: 13px; color: var(--text); background: var(--bg);
    outline: none; font-family: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  .modal-card select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .modal-actions { display: flex; gap: 8px; margin-top: 4px; }
  .field { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
  .field span { font-weight: 500; }
  .input-row { display: flex; gap: 8px; align-items: center; }
  .input-row input { flex: 1; }
  .input-row .icon-btn { flex: 0 0 auto; padding: 8px 10px; }
  .btn {
    flex: 1; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg); color: var(--text); font-size: 13px; cursor: pointer;
    transition: background .15s;
  }
  .btn:hover { background: var(--surface-2); }
  .btn.primary { background: var(--accent); color: #fff; border: none; font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); }

  .empty { color: var(--muted); }
</style>
