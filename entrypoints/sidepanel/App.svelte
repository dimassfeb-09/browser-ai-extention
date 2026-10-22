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
  import { runAgent, describeAction } from '../../src/core/agentLoop';
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
  import type { ChatMessage, ChatState, StepRecord } from '../../src/core/types';
  import {
    deleteRecipe,
    findRecipe,
    formatRecipes,
    normalizeRecipes,
    saveRecipe,
    type Recipe,
  } from '../../src/core/recipes';

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
  let historyQuery = $state('');
  let showSettings = $state(false);
  let models = $state<string[]>([]);
  let modelsLoading = $state(false);
  let modelsError = $state('');
  let compacting = $state(false);
  let contextTokens = $state(0);
  let lastCompactTokens = $state<number | null>(null);
  let slashBusy = $state(false);
  let slashBusyLabel = $state('');
  const openingPrompts = [
    'Fill this form and save the record.',
    'Find a record by name or email.',
    'Summarize the data on this page.',
    'Open another section or create a new entry.',
  ];
  let openingIndex = $state(0);
  const composerPlaceholders = [
    'Ketik tujuanmu di sini, contoh: isi form ini lalu simpan',
    'Mau saya bantu cari data, lalu tampilkan detailnya?',
    'Contoh: ringkas semua data yang sedang tampil di halaman ini',
    'Mau buka section lain atau buat data baru?',
    'Ketik /help untuk lihat daftar perintah cepat',
    'Gunakan /model untuk pilih model yang sesuai',
    'Simpan alur kerja yang sering dipakai dengan /recipe save nama',
    'Jalankan macro dengan /recipe run nama',
    'Ketik /export untuk Unduh riwayat chat',
    'Mau tanya cara pakai? Ketik /help',
    'Deskripsikan langkah yang ingin saya lakukan di tab ini',
    'Shift+Enter untuk baris baru, Enter untuk kirim',
  ];
  // Typewriter-style composer placeholder. We type the current phrase
  // one character at a time (left-to-right), hold it, then clear and
  // move on to the next helpful prompt.
  let typedPlaceholder = $state('');
  let placeholderPhraseIndex = $state(0);
  let theme = $state<'dark' | 'light'>('dark');
  let recipes = $state<Recipe[]>([]);
  let lastGoal = $state('');

  let deletingIds = $state<Set<string>>(new Set());

  let confirmOpen = $state(false);
  let confirmTitle = $state('');
  let confirmMessage = $state('');
  let confirmResolve = $state<((value: boolean) => void) | null>(null);
  function requestConfirm(title: string, message: string): Promise<boolean> {
    confirmTitle = title;
    confirmMessage = message;
    confirmOpen = true;
    return new Promise<boolean>((resolve) => {
      confirmResolve = resolve;
    });
  }
  function resolveConfirm(value: boolean) {
    confirmOpen = false;
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve?.(value);
  }

  let actionApprovalOpen = $state(false);
  let actionApprovalTitle = $state('');
  let actionApprovalMessage = $state('');
  let actionApprovalResolve = $state<((decision: 'allow' | 'allow-all' | 'deny') => void) | null>(null);
  function requestActionApproval(title: string, message: string): Promise<'allow' | 'allow-all' | 'deny'> {
    actionApprovalTitle = title;
    actionApprovalMessage = message;
    actionApprovalOpen = true;
    return new Promise<'allow' | 'allow-all' | 'deny'>((resolve) => {
      actionApprovalResolve = resolve;
    });
  }
  function resolveActionApproval(decision: 'allow' | 'allow-all' | 'deny') {
    actionApprovalOpen = false;
    const resolve = actionApprovalResolve;
    actionApprovalResolve = null;
    resolve?.(decision);
  }

  /** Commands matching what is being typed in the composer (shown as a
   *  suggestion menu while the draft is a bare '/…'). */
  let modelSlashMode = $derived(/^\/model/i.test(draft.trim()));
  let recipeSlashMode = $derived(/^\/recipe\b/i.test(draft.trim()));
  let recipeSlashParts = $derived(
    recipeSlashMode
      ? draft.trim().replace(/^\/recipe\s*/i, '').split(/\s+/).filter(Boolean)
      : [],
  );
  let recipeSlashAction = $derived(recipeSlashParts[0]?.toLowerCase() ?? '');
  let recipeSlashActionKnown = $derived(
    ['save', 'add', 'run', 'use', 'delete', 'remove', 'list'].includes(recipeSlashAction),
  );
  let recipeQuery = $derived(
    recipeSlashMode
      ? (recipeSlashActionKnown ? recipeSlashParts.slice(1) : recipeSlashParts)
          .join(' ')
          .toLowerCase()
      : '',
  );
  let recipeSuggestions = $derived(
    recipeSlashMode && recipeSlashAction !== 'list'
      ? recipes.filter((r) => r.name.toLowerCase().includes(recipeQuery))
      : [],
  );
  let slashMatches = $derived(
    modelSlashMode || recipeSlashMode
      ? []
      : draft.trimStart().startsWith('/') && !draft.trim().includes(' ')
        ? matchSlashCommands(draft.trim())
        : [],
  );
  /** When the composer holds `/model …`, offer the loaded models as a
   *  dropdown so the user can pick instead of typing the name. */
  let modelQuery = $derived(
    modelSlashMode ? draft.trim().replace(/^\/model\s*/i, '').toLowerCase() : '',
  );
  let modelSuggestions = $derived(
    modelSlashMode
      ? (models.length ? models : [settings.model])
          .filter((m) => m.toLowerCase().includes(modelQuery))
      : [],
  );
  let messagesEl: HTMLElement | undefined = $state();
  const signal = { aborted: false };

  let current = $derived(activeSession(chatState, tabId));
  let history = $derived(sortedSessions(chatState));
  let filteredHistory = $derived(
    historyQuery.trim()
      ? history.filter((s) => s.title.toLowerCase().includes(historyQuery.trim().toLowerCase()))
      : history,
  );
  function groupHistory(sessions: typeof history) {
    const now = new Date();
    const buckets: Record<string, typeof history> = {
      Today: [],
      Yesterday: [],
      'Previous 7 days': [],
      Older: [],
    };
    for (const s of sessions) {
      const d = new Date(s.updatedAt);
      const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
      if (d.toDateString() === now.toDateString()) buckets.Today.push(s);
      else if (diffDays === 1) buckets.Yesterday.push(s);
      else if (diffDays <= 7) buckets['Previous 7 days'].push(s);
      else buckets.Older.push(s);
    }
    return Object.entries(buckets).filter(([, items]) => items.length > 0);
  }
  let historyGroups = $derived(groupHistory(filteredHistory));

  async function persist() {
    await store.save($state.snapshot(chatState));
  }

  async function scrollToBottom() {
    await tick();
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  onMount(async () => {
    settings = await loadSettings();
    models = settings.models ?? [];
    if (settings.model && !models.includes(settings.model)) models = [settings.model, ...models];
    settings.models = models;
    recipes = normalizeRecipes(settings.recipes ?? []);
    settings.recipes = recipes;
    theme = settings.theme ?? 'dark';
    document.documentElement.dataset.theme = theme;
    windowId = await getCurrentWindowId();
    tabId = await getActiveTabId(windowId);
    const loaded = await store.load();
    chatState = ensureTabSession(loaded, windowId, tabId, uid(), Date.now());
    await persist();
    await scrollToBottom();
    setInterval(() => { openingIndex = (openingIndex + 1) % openingPrompts.length; }, 3200);

    // Typewriter loop for the composer placeholder.
    let phraseTimer: ReturnType<typeof setTimeout> | null = null;
    const typeNext = () => {
      // Placeholder only belongs to an empty/new chat: a session that already
      // has turns should keep the composer clean (no dancing prompt text).
      if (!current || current.messages.length !== 0) {
        if (typedPlaceholder) typedPlaceholder = '';
        phraseTimer = setTimeout(typeNext, 200);
        return;
      }
      const phrase = composerPlaceholders[placeholderPhraseIndex % composerPlaceholders.length];
      if (typedPlaceholder.length < phrase.length) {
        typedPlaceholder = phrase.slice(0, typedPlaceholder.length + 1);
        phraseTimer = setTimeout(typeNext, 42);
      } else {
        phraseTimer = setTimeout(() => {
          typedPlaceholder = '';
          placeholderPhraseIndex = (placeholderPhraseIndex + 1) % composerPlaceholders.length;
          phraseTimer = setTimeout(typeNext, 260);
        }, 1500);
      }
    };
    phraseTimer = setTimeout(typeNext, 200);
    // Keep a reference so the browser can clean up on unload (best-effort).
    void phraseTimer;
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
    if (!(await requestConfirm('Delete chat?', 'This chat and its messages will be removed. This cannot be undone.'))) return;
    deletingIds = new Set([...deletingIds, id]);
    window.setTimeout(() => {
      deletingIds = new Set([...deletingIds].filter((x) => x !== id));
      chatState = removeSession(chatState, id);
      chatState = ensureTabSession(chatState, windowId, tabId, uid(), Date.now());
      void persist();
    }, 520);
  }

  async function clearCurrentChat() {
    if (!current) return;
    if (!(await requestConfirm('Clear this chat?', 'All messages and agent memory in this chat will be removed.'))) return;
    chatState = upsertSession(chatState, clearSession(current, Date.now()));
    await persist();
    await scrollToBottom();
  }

  async function deleteCurrent() {
    if (!current) return;
    await deleteSession(current.id);
  }

  async function clearAllHistory() {
    if (!(await requestConfirm('Clear all history?', 'Every chat in this window will be removed. This cannot be undone.'))) return;
    const ids = history.map((s) => s.id);
    deletingIds = new Set(ids);
    window.setTimeout(() => {
      deletingIds = new Set();
      chatState = ensureTabSession(emptyChatState(), windowId, tabId, uid(), Date.now());
      void persist();
      showHistory = false;
    }, 520);
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
      settings.models = models;
      if (models.length > 0 && !models.includes(settings.model)) {
        settings.model = models[0];
      }
      if (models.length === 0) modelsError = 'No models returned.';
      else void saveSettings(settings);
    } catch (err) {
      modelsError = `Failed to load models: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      modelsLoading = false;
    }
  }

  async function saveSettingsNow() {
    settings.models = models;
    settings.recipes = recipes;
    await saveSettings(settings);
    showSettings = false;
  }

  async function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    await saveSettings(settings);
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
      const beforeTokens = Math.round(rendered.length / 4);
      const llm = new ChatCompletionsClient({
        apiKey: settings.apiKey,
        model: settings.model,
        baseURL: settings.baseURL,
      });
      const summary = await llm.summarize(COMPACT_SYSTEM, rendered);
      lastCompactTokens = Math.round(summary.length / 4);
      const lastTs = Math.max(...session.messages.map((m) => m.ts));
      chatState = upsertSession(chatState, {
        ...session,
        compactSummary: summary,
        compactCutoff: lastTs,
        updatedAt: Date.now(),
      });
      await persist();
      await notice(
        `Compacted ${folded.length} messages (~${beforeTokens} → ~${lastCompactTokens} tokens). Future runs carry this brief instead of the full history:\n\n${summary}`,
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
    if (slashBusy && cmd.name !== 'stop') return;
    slashBusy = true;
    slashBusyLabel = cmd.name;
    try {
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
          if (!models.includes(cmd.arg)) models = [cmd.arg, ...models];
          settings.models = models;
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
      case 'recipe': {
        const parts = cmd.arg.trim().split(/\s+/).filter(Boolean);
        const action = (parts[0] ?? 'list').toLowerCase();
        if (action === 'list' || action === '') {
          await notice(formatRecipes(recipes));
          break;
        }
        if (action === 'save' || action === 'add') {
          const name = parts[1];
          if (!name) {
            await notice('Usage: /recipe save <name> [goal] — omit [goal] to save your last goal.');
            break;
          }
          const goal = parts.slice(2).join(' ').trim() || lastGoal;
          if (!goal) {
            await notice('No goal to save yet. Send a goal first, or use /recipe save <name> <goal>.');
            break;
          }
          recipes = saveRecipe(recipes, name, goal, Date.now());
          settings.recipes = recipes;
          await saveSettings(settings);
          await notice(`Saved recipe "${name.trim()}" → ${goal}`);
          break;
        }
        if (action === 'delete' || action === 'remove') {
          const name = parts[1];
          if (!name) {
            await notice('Usage: /recipe delete <name>.');
            break;
          }
          if (!findRecipe(recipes, name)) {
            await notice(`No recipe named "${name}".`);
            break;
          }
          if (!(await requestConfirm('Delete recipe?', `Recipe "${name}" will be removed.`))) break;
          recipes = deleteRecipe(recipes, name);
          settings.recipes = recipes;
          await saveSettings(settings);
          await notice(`Deleted recipe "${name}".`);
          break;
        }
        if (action === 'run' || action === 'use') {
          const name = parts[1];
          if (!name) {
            await notice('Usage: /recipe run <name>.');
            break;
          }
          const recipe = findRecipe(recipes, name);
          if (!recipe) {
            await notice(`No recipe named "${name}". Use /recipe list.`);
            break;
          }
          await send(recipe.goal);
          break;
        }
        // Treat a bare name as "run": /recipe morning-report
        const recipe = findRecipe(recipes, cmd.arg.trim());
        if (recipe) {
          await send(recipe.goal);
        } else {
          await notice(`Unknown recipe action "${action}". Use save, run, list, or delete.`);
        }
        break;
      }
    }
    } finally {
      slashBusy = false;
      slashBusyLabel = '';
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
    lastGoal = goal;
    await saveSettings(settings);

    const now = Date.now();
    const injectedContext = [
      conversation.length
        ? `## Conversation memory\n${conversation
            .map((t) => `- ${t.role === 'user' ? 'User' : 'Agent'}: ${t.content}`)
            .join('\n')}`
        : '## Conversation memory\n- None yet. This is the first turn in this chat.',
      `## Goal\n${goal}`,
      '## Also sent on every step\n- Live page snapshot (URL, title, indexed interactive elements, visible text)\n- Recent step/action history and results\n- Harness notices (unchanged page, navigation, checkpoints)',
    ].join("\\n\\n");
    contextTokens = Math.round(injectedContext.length / 4);
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: goal, ts: now, injectedContext };
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
    let guardrailBypass = settings.actionGuardrailsBypass === true;
    const approveAction = async (action: any, snapshot: any): Promise<boolean> => {
      if (!(settings.actionGuardrails ?? false) || guardrailBypass || (settings.actionGuardrailsBypass ?? false)) return true;
      const el = (action.index != null ? snapshot?.elements?.[action.index] : null) as any;
      const target = el
        ? `${el.tag}${el.label ? ` “${el.label}”` : ''}${el.context ? ` (${el.context})` : ''}`
        : '';
      const detail = `${describeAction(action)}${target ? ` on ${target}` : ''}`;
      const decision = await requestActionApproval('Allow browser action?', `${detail}\n\nAllow this action?`);
      if (decision === 'allow-all') {
        guardrailBypass = true;
        return true;
      }
      return decision === 'allow';
    };
    const steps: string[] = [];
    const runRecords: StepRecord[] = [];
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
        onToken: (delta) => {
          const live = activeSession(chatState, tabId);
          if (!live) return;
          const msgs = live.messages.map((m) =>
            m.id === draftMsg.id ? { ...m, content: (m.content ?? '') + delta } : m,
          );
          chatState = upsertSession(chatState, { ...live, messages: msgs });
          void scrollToBottom();
        },
        approveAction,
        maxSteps: settings.maxSteps > 0 ? settings.maxSteps : 100_000,
        logger: {
          log: (event, data) => {
            const payload = (data ?? {}) as { step?: number; action?: any; result?: any };
            steps.push(`${event}: ${JSON.stringify(data ?? '')?.slice(0, 240) ?? ''}`);
            if (event === 'action' && payload.action) {
              const rec: StepRecord = { step: payload.step ?? runRecords.length + 1, snapshotHash: '', action: payload.action };
              if (payload.action.type === 'wait') {
                rec.result = { ok: true, message: `Waited ${payload.action.ms}ms`, level: 0 };
              }
              runRecords.push(rec);
            }
            if (event === 'act-result' && typeof payload.step === 'number') {
              const rec = [...runRecords].reverse().find((r) => r.step === payload.step && !r.result);
              if (rec && payload.result) rec.result = payload.result;
              else {
                const existing = [...runRecords].reverse().find((r) => r.step === payload.step);
                if (existing && payload.result) existing.result = payload.result;
              }
            }
            const live = activeSession(chatState, tabId);
            if (live) {
              const msgs = live.messages.map((m) =>
                m.id === draftMsg.id ? { ...m, steps: [...steps], stepRecords: [...runRecords] } : m,
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
            ? { ...m, content: result.summary, status: result.status, steps: [...steps], stepRecords: [...result.history] }
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
            ? { ...m, content: `Error: ${message}`, status: 'error', steps: [...steps], stepRecords: [...runRecords] }
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
  function formatChatTime(ts: number) {
    if (!ts) return '';
    return new Date(ts).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function renderMarkdown(value: string): string {
    const escaped = escapeHtml(value ?? '');
    const lines = escaped.split('\n');
    const out: string[] = [];
    let inList = false;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length === 0) return;
      out.push(`<p>${inlineMarkdown(para.join('<br>'))}</p>`);
      para = [];
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^###\s+/.test(line)) {
        flushPara();
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h4>${inlineMarkdown(line.replace(/^###\s+/, ''))}</h4>`);
        continue;
      }
      if (/^##\s+/.test(line)) {
        flushPara();
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h3>${inlineMarkdown(line.replace(/^##\s+/, ''))}</h3>`);
        continue;
      }
      if (/^#\s+/.test(line)) {
        flushPara();
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h2>${inlineMarkdown(line.replace(/^#\s+/, ''))}</h2>`);
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        flushPara();
        if (!inList) { out.push('<ul>'); inList = true; }
        const item = inlineMarkdown(line.replace(/^[-*]\s+/, ''));
        out.push(`<li>${item}</li>`);
        continue;
      }
      if (inList) { out.push('</ul>'); inList = false; }
      if (line.trim() === '') {
        flushPara();
        continue;
      }
      para.push(line);
    }
    flushPara();
    if (inList) out.push('</ul>');
    return out.join('');
  }
  function inlineMarkdown(value: string): string {
    return value
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<main>
  <div class="topbar">
    <div class="topbar-left">
      <button id="historyBtn" class="icon-btn" title="Chat history" aria-label="Chat history" onclick={() => (showHistory = !showHistory)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
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
      <button id="themeBtn" class="icon-btn" title="Toggle theme" aria-label="Toggle theme" onclick={() => void toggleTheme()}>
        {#if theme === 'dark'}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
        {:else}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        {/if}
      </button>
      <button id="cfgBtn" class="icon-btn" title="AI Config" aria-label="AI Config" onclick={() => { if (settings.model && !models.includes(settings.model)) models = [settings.model, ...models]; showSettings = true; }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
  </div>

  <div id="log" class="log" data-testid="messages" bind:this={messagesEl}>
    {#if !current || current.messages.length === 0}
      <div class="empty-state">
        <div class="empty-icon">A</div>
        <div class="empty-title visually-hidden">No messages yet</div>
        <div class="empty-greeting">How can I help you today?</div>
        <div class="empty-rotate" aria-live="polite">{openingPrompts[openingIndex]}</div>
        <div class="empty-chips">
          <button class="empty-chip" type="button" onclick={() => (draft = 'Isi form ini dengan data contoh dan simpan')}>Fill a form</button>
          <button class="empty-chip" type="button" onclick={() => (draft = 'Cari data berdasarkan nama/email lalu tampilkan detailnya')}>Search a record</button>
          <button class="empty-chip" type="button" onclick={() => (draft = 'Ringkas data yang sedang tampil di halaman ini')}>Summarize page</button>
        </div>
        <div class="empty-text">Write a goal for the active tab below and press Send.</div>
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
              {#if m.injectedContext}
                <details class="injected-details">
                  <summary>Show prompt details</summary>
                  <pre class="injected-pre">{m.injectedContext}</pre>
                </details>
              {/if}
              <div class="msg-time">{formatChatTime(m.ts)}</div>
            {:else}
              <div class="assistant-bubble">
                <div class="assistant-text">{@html renderMarkdown(m.content)}</div>
              </div>
              <div class="msg-time">{formatChatTime(m.ts)}{#if m.status} · {m.status}{/if}</div>
              {#if (m.stepRecords && m.stepRecords.length) || (m.steps && m.steps.length)}
                <details class="stream-details">
                  <summary>Step timeline ({m.stepRecords?.length ?? m.steps?.length})</summary>
                  {#if m.stepRecords && m.stepRecords.length}
                    <ol class="step-timeline">
                      {#each m.stepRecords as r (r.step)}
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
                  {:else}
                    <pre class="stream-pre">{m.steps.join('\n')}</pre>
                  {/if}
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
    {:else if modelSlashMode}
      <div class="slash-menu" data-testid="slash-menu">
        <button class="slash-item" onclick={() => void loadModels()}>
          <span class="slash-usage">↻ Refresh</span>
          <span class="slash-desc">{modelsLoading ? 'Loading models…' : 'Fetch latest models from endpoint'}</span>
        </button>
        {#each modelSuggestions as m (m)}
          <button
            class="slash-item"
            onclick={() => {
              draft = `/model ${m}`;
              document.getElementById('input')?.focus();
            }}
          >
            <span class="slash-usage">{m}</span>
            <span class="slash-desc">{m === settings.model ? 'current model' : 'switch to this model'}</span>
          </button>
        {/each}
        {#if modelSuggestions.length === 0}
          <div class="slash-item" style="cursor: default;">
            <span class="slash-usage">—</span>
            <span class="slash-desc">No cached models. Click refresh or load in Settings.</span>
          </div>
        {/if}
      </div>
    {:else if recipeSlashMode}
      <div class="slash-menu" data-testid="slash-menu">
        {#each recipeSuggestions as r (r.name)}
          <button
            class="slash-item"
            onclick={() => {
              const action =
                recipeSlashAction === 'delete' || recipeSlashAction === 'remove'
                  ? 'delete'
                  : 'run';
              draft = `/recipe ${action} ${r.name}`;
              document.getElementById('input')?.focus();
            }}
          >
            <span class="slash-usage">{r.name}</span>
            <span class="slash-desc">{r.goal}</span>
          </button>
        {/each}
        {#if recipeSuggestions.length === 0}
          <div class="slash-item" style="cursor: default;">
            <span class="slash-usage">—</span>
            <span class="slash-desc">
              {recipes.length === 0
                ? 'No saved recipes. Use /recipe save <name>.'
                : 'No recipes match. Try another name.'}
            </span>
          </div>
        {/if}
      </div>
    {/if}
    <div class="input-shell">
      <textarea
        id="input"
        bind:value={draft}
        rows="1"
        placeholder={current && current.messages.length > 0 ? 'Chat' : typedPlaceholder}
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
    <div class="input-hint">
      {#if compacting}
        Compacting conversation…
      {:else if slashBusy}
        Running /{slashBusyLabel}…
      {:else}
        Enter to send · Shift+Enter for new line{contextTokens ? ` · ~${contextTokens} tok context` : ''}{lastCompactTokens ? ` · last compact ~${lastCompactTokens} tok` : ''}
      {/if}
    </div>
  </div>

  {#if confirmOpen}
    <div class="confirm-backdrop" role="presentation" onclick={() => resolveConfirm(false)}>
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" onclick={(e) => e.stopPropagation()}>
        <h3 id="confirmTitle">{confirmTitle}</h3>
        <p>{confirmMessage}</p>
        <div class="confirm-actions">
          <button class="btn-ghost" type="button" onclick={() => resolveConfirm(false)}>Cancel</button>
          <button class="btn-danger" type="button" onclick={() => resolveConfirm(true)}>Delete</button>
        </div>
      </div>
    </div>
  {/if}

  {#if actionApprovalOpen}
    <div class="confirm-backdrop" role="presentation" onclick={() => resolveActionApproval('deny')}>
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="actionApprovalTitle" onclick={(e) => e.stopPropagation()}>
        <h3 id="actionApprovalTitle">{actionApprovalTitle}</h3>
        <p>{actionApprovalMessage}</p>
        <div class="confirm-actions">
          <button class="btn-ghost" type="button" onclick={() => resolveActionApproval('deny')}>Deny</button>
          <button class="btn-ghost" type="button" onclick={() => resolveActionApproval('allow-all')}>Bypass</button>
          <button class="btn primary" type="button" onclick={() => resolveActionApproval('allow')}>Allow</button>
        </div>
        <div class="approval-hint">Bypass: jalankan aksi langsung untuk run ini (tidak disimpan).</div>
      </div>
    </div>
  {/if}

  <div id="historyBackdrop" class="drawer-backdrop" class:open={showHistory} onclick={() => (showHistory = false)} role="presentation"></div>
  <div id="historyDrawer" class="history-drawer" class:open={showHistory} data-testid="history">
    <div class="drawer-header">
      <div class="drawer-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Chats
      </div>
      <button class="icon-btn" title="Close" onclick={() => (showHistory = false)}>✕</button>
    </div>

    <button class="drawer-new-chat-btn" onclick={newChat}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New chat
    </button>

    <div class="history-search">
      <input
        type="text"
        placeholder="Search chats…"
        bind:value={historyQuery}
        aria-label="Search chats"
      />
    </div>

    <div id="sessionList" class="drawer-list">
      {#if filteredHistory.length === 0}
        <div class="drawer-empty">{history.length === 0 ? 'No chats yet.' : 'No chats match.'}</div>
      {:else}
        {#each historyGroups as [label, items] (label)}
          <div class="history-group">
            <div class="history-group-label">{label}</div>
            {#each items as s (s.id)}
              <div class="session-item" class:active={current?.id === s.id} class:erasing={deletingIds.has(s.id)}>
                <button class="open" onclick={() => openSession(s.id)}>
                  <div class="session-title">{s.title}</div>
                  <div class="session-meta">{running && current?.id === s.id ? '⚡ Running... · ' : ''}{s.messages.length} {s.messages.length === 1 ? 'message' : 'messages'} · {formatTime(s.updatedAt)}{chatState.byTab[tabId] === s.id ? ' · this tab' : ''}</div>
                </button>
                <button class="session-del-btn" title="Delete chat" disabled={deletingIds.has(s.id)} onclick={() => deleteSession(s.id)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            {/each}
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
      <div class="modal-header">
        <div>
          <div class="modal-title">AI Configuration</div>
          <div class="modal-subtitle">Connection, model, dan perilaku agent.</div>
        </div>
        <button class="icon-btn" type="button" aria-label="Close settings" onclick={() => (showSettings = false)}>✕</button>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Connection</div>
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
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Agent</div>
        <label class="field">
          <span>Max steps per run (0 = no limit)</span>
          <input type="number" bind:value={settings.maxSteps} min="0" step="1" />
        </label>
        <label class="field checkbox">
          <input type="checkbox" bind:checked={settings.actionGuardrails} />
          <span>Guardrails</span>
          <small class="field-hint">Minta approval sebelum click/type/navigate.</small>
        </label>
        <label class="field checkbox">
          <input type="checkbox" bind:checked={settings.actionGuardrailsBypass} />
          <span>Bypass by default</span>
          <small class="field-hint">Jalankan aksi langsung (disimpan).</small>
        </label>
      </div>

      <div class="modal-actions">
        <button class="btn primary" onclick={saveSettingsNow}>Save settings</button>
      </div>
    </div>
  </div>
</main>

<style>
  :global(html[data-theme="light"]) {
    --bg: #f7f8fa;
    --surface: #ffffff;
    --surface-2: #f1f2f5;
    --surface-3: #e7e9ee;
    --border: #d8dbe3;
    --border-strong: #c3c7d2;
    --text: #1f2328;
    --muted: #5b6472;
    --accent: #10a37f;
    --accent-soft: rgba(16, 163, 127, 0.14);
    --danger: #dc2626;
    --danger-soft: rgba(220, 38, 38, 0.10);
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.08);
    --shadow-md: 0 10px 30px rgba(0, 0, 0, 0.12);
  }
  :global(:root) {
    --bg: #0f1115;
    --surface: #171a21;
    --surface-2: #20242d;
    --surface-3: #2a2f3a;
    --border: #2b303b;
    --border-strong: #3a4150;
    --text: #f3f5f8;
    --muted: #9aa4b2;
    --accent: #10a37f;
    --accent-soft: rgba(16, 163, 127, 0.16);
    --danger: #ef4444;
    --danger-soft: rgba(239, 68, 68, 0.14);
    --radius: 14px;
    --radius-sm: 8px;
    --radius-lg: 20px;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
    --shadow-md: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  :global(html, body) { margin: 0; padding: 0; height: 100%; background: var(--bg); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  button { font: inherit; color: var(--text); background: transparent; border: 1px solid var(--border); cursor: pointer; }
  main {
    height: 100vh; width: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
    display: flex; flex-direction: column;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
    position: relative;
  }

  /* ---------- top bar ---------- */
  .topbar {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }
  .topbar-left {
    display: flex; align-items: center; gap: 10px;
    min-width: 0; flex: 1;
  }
  .topbar-right {
    display: flex; align-items: center; gap: 4px;
    flex-shrink: 0;
  }
  .logo {
    width: 26px; height: 26px; border-radius: 8px;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 13px;
    flex-shrink: 0;
  }
  .header-info { min-width: 0; }
  .title { font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .subtitle { font-size: 11px; color: var(--muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .icon-btn {
    width: 30px; height: 30px; border-radius: var(--radius-sm);
    border: 1px solid transparent; background: transparent;
    color: var(--muted); cursor: pointer; font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    transition: background .15s, color .15s, border-color .15s;
    flex-shrink: 0;
  }
  .icon-btn:hover { background: var(--surface-2); color: var(--text); }
  .icon-btn:active { transform: scale(0.94); }
  .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* ---------- messages ---------- */
  .log {
    flex: 1; overflow-y: auto;
    padding: 14px 0 20px;
    display: flex; flex-direction: column;
    scroll-behavior: smooth;
  }
  .log::-webkit-scrollbar { width: 8px; }
  .log::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 4px; }
  .log::-webkit-scrollbar-track { background: transparent; }

  .msg-row { display: flex; gap: 10px; padding: 10px 14px; }
  .msg-row.user { justify-content: flex-end; align-items: flex-end; }
  .msg-row.assistant { justify-content: flex-start; align-items: flex-start; }
  .msg-row.system, .msg-row.error { justify-content: center; padding: 6px 18px; }

  .avatar {
    width: 26px; height: 26px; border-radius: 8px;
    flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    font-size: 11.5px; font-weight: 700;
  }
  .avatar.assistant { background: var(--accent); color: #fff; }
  .avatar.user { background: var(--surface-3); color: var(--text); }

  .msg-content { flex: 1; min-width: 0; max-width: 88%; }
  .msg-row.user .msg-content { flex: 0 1 auto; max-width: 82%; }

  .msg-row.user .bubble {
    background: var(--surface-2); color: var(--text);
    padding: 9px 14px; border-radius: var(--radius);
    border: 1px solid var(--border);
    border-bottom-right-radius: 2px;
    line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    display: block;
    margin-left: auto;
    box-shadow: var(--shadow-sm);
  }
  .assistant-text {
    color: var(--text); line-height: 1.6;
    white-space: normal; word-break: break-word; letter-spacing: -0.003em;
    padding: 2px 0;
  }
  .assistant-text :global(p) { margin: 0 0 6px; }
  .assistant-text :global(p:last-child) { margin-bottom: 0; }
  .assistant-text :global(h2) { font-size: 15px; margin: 8px 0 4px; color: var(--text); }
  .assistant-text :global(h3) { font-size: 14px; margin: 8px 0 4px; color: var(--text); }
  .assistant-text :global(h4) { font-size: 13px; margin: 6px 0 3px; color: var(--text); }
  .assistant-text :global(strong) { font-weight: 700; color: var(--text); }
  .assistant-text :global(em) { font-style: italic; }
  .assistant-text :global(code) {
    font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; padding: 1px 5px;
  }
  .assistant-text :global(ul) { margin: 4px 0 6px 18px; }
  .assistant-text :global(li) { margin: 2px 0; }
  .assistant-bubble {
    background: var(--surface); color: var(--text);
    padding: 10px 14px; border-radius: var(--radius);
    border: 1px solid var(--border);
    border-top-left-radius: 2px;
    line-height: 1.6; white-space: pre-wrap; word-break: break-word;
    box-shadow: var(--shadow-sm);
    max-width: 92%;
  }
  .msg-time {
    font-size: 10.5px; color: var(--muted); margin-top: 4px;
  }
  .injected-details {
    margin-top: 4px;
  }
  .injected-details summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
    font-size: 10.5px;
    color: var(--muted);
    font-weight: 500;
  }
  .injected-details summary::-webkit-details-marker { display: none; }
  .injected-details summary::before { content: '▸ '; }
  .injected-details[open] summary::before { content: '▾ '; }
  .injected-pre {
    margin: 3px 0 0;
    padding: 6px 8px;
    background: var(--surface2);
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 10.5px;
    line-height: 1.4;
    max-height: 120px;
    overflow: auto;
  }
  .msg-row.user .msg-time { text-align: right; }
  .msg-text.system { color: var(--muted); font-size: 12px; text-align: center; }
  .msg-text.error { color: var(--danger); font-size: 12px; text-align: center; }

  .chip {
    font-size: 10px; background: var(--surface-3); color: var(--text);
    border-radius: 999px; padding: 2px 8px; width: fit-content; margin-top: 6px;
    border: 1px solid var(--border);
  }
  .msg-row.user .chip { background: var(--surface-3); color: var(--text); }

  .stream-details {
    margin-top: 6px; font-size: 12px; color: var(--muted);
  }
  .stream-details summary {
    cursor: pointer; user-select: none; padding: 4px 0;
    list-style: none; color: var(--muted);
    transition: color .15s;
    font-weight: 600;
  }
  .stream-details summary::-webkit-details-marker { display: none; }
  .stream-details summary::before { content: "▸ "; }
  .stream-details[open] summary::before { content: "▾ "; }
  .stream-details summary:hover { color: var(--text); }
  .stream-pre {
    margin-top: 6px; padding: 10px 12px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); max-height: 160px; overflow: auto;
    white-space: pre-wrap; font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px; color: var(--muted); line-height: 1.45;
  }
  .step-timeline {
    list-style: none; margin: 8px 0 0; padding: 0;
    display: flex; flex-direction: column; gap: 8px;
  }
  .step-timeline li {
    display: grid; grid-template-columns: 24px 1fr; gap: 8px;
    align-items: start; font-size: 11.5px;
  }
  .step-timeline li.failed { color: var(--danger); }
  .step-index {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--surface2); color: var(--accent);
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums;
  }
  .step-line-body { display: flex; flex-direction: column; gap: 2px; }
  .step-action {
    color: var(--text); font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px; line-height: 1.35;
  }
  .step-payload {
    color: var(--muted); font-style: italic; font-size: 11px;
  }
  .step-result {
    font-size: 11px; padding: 1px 0; line-height: 1.4;
  }
  .step-result.ok { color: var(--accent); }
  .step-result.err { color: var(--danger); }
  .step-result.pending { color: var(--muted); }

  .status { font-size: 12px; margin: 0 14px 4px; color: var(--muted); }

  /* ---------- empty state ---------- */
  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; padding: 40px 24px; text-align: center; color: var(--muted);
  }

  .empty-icon {
    width: 44px; height: 44px; border-radius: 12px;
    background: var(--surface-2); color: var(--accent);
    display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 600;
    margin-bottom: 6px;
  }
  .empty-title { font-size: 14px; font-weight: 600; color: var(--text); }
  .empty-title.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .empty-greeting { font-size: 18px; font-weight: 600; color: var(--text); letter-spacing: -0.015em; margin-bottom: 6px; }
  .empty-rotate { min-height: 18px; font-size: 13px; color: var(--muted); line-height: 1.4; }
  .empty-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 14px; max-width: 320px; }
  .empty-chip { font-size: 12px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; transition: border-color .15s; }
  .empty-chip:hover { border-color: var(--accent); }
  .empty-text { font-size: 12.5px; max-width: 260px; line-height: 1.5; margin-top: 12px; }

  /* ---------- composer ---------- */
  .inputbar {
    padding: 10px 12px 12px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }
  .slash-menu {
    display: flex; flex-direction: column; gap: 2px;
    margin-bottom: 8px; max-height: 220px; overflow-y: auto;
    padding: 4px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .slash-item {
    display: flex; gap: 10px; align-items: baseline;
    text-align: left; padding: 7px 10px;
    border: none; border-radius: 6px;
    background: transparent; color: var(--text);
    cursor: pointer; font: inherit;
    transition: background .12s;
  }
  .slash-item:hover { background: var(--surface-2); }
  .slash-usage { font-weight: 600; white-space: nowrap; color: var(--accent); }
  .slash-desc { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .input-shell {
    display: flex; align-items: flex-end; gap: 8px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 22px; padding: 6px 8px 6px 14px;
    box-shadow: var(--shadow-sm);
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
    width: 32px; height: 32px; border-radius: 50%; border: none;
    color: #fff; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: filter .15s, transform .08s, opacity .15s;
  }
  #send { background: var(--accent); }
  #cancel { background: var(--danger); }
  #send:disabled { opacity: .45; cursor: default; }
  #send:hover:not(:disabled) { filter: brightness(1.08); }
  #send:active:not(:disabled) { transform: scale(.94); }
  #cancel:hover { filter: brightness(1.08); }
  #cancel:active { transform: scale(.94); }
  #send:focus-visible, #cancel:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }

  .input-hint { font-size: 11px; color: var(--muted); text-align: center; margin-top: 6px; }

  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

  /* ---------- history drawer ---------- */
  .drawer-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.6);
    z-index: 30; opacity: 0; pointer-events: none;
    transition: opacity .2s ease;
    backdrop-filter: blur(2px);
  }
  .drawer-backdrop.open { opacity: 1; pointer-events: auto; }
  .history-drawer {
    position: fixed; top: 0; bottom: 0; left: 0;
    width: 300px; max-width: 86%;
    background: var(--surface); border-right: 1px solid var(--border);
    z-index: 31; transform: translateX(-100%);
    transition: transform .25s cubic-bezier(0.16, 1, 0.3, 1);
    display: flex; flex-direction: column;
    box-shadow: var(--shadow-md);
  }
  .history-drawer.open { transform: translateX(0); }

  .drawer-header {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
    background: var(--surface);
  }
  .drawer-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .drawer-actions { display: flex; align-items: center; gap: 6px; }

  .drawer-new-chat-btn {
    display: flex; align-items: center; gap: 8px;
    margin: 10px 12px 6px;
    padding: 9px 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text); font-size: 13px; font-weight: 500;
    cursor: pointer; transition: background .15s, border-color .15s, color .15s;
  }
  .drawer-new-chat-btn:hover { background: var(--surface-3); border-color: var(--accent); color: var(--accent); }

  .drawer-list {
    flex: 1; overflow-y: auto; padding: 6px 8px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .drawer-list::-webkit-scrollbar { width: 6px; }
  .drawer-list::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 3px; }

  .history-search {
    padding: 8px 12px 4px;
  }
  .history-search input {
    width: 100%; padding: 7px 10px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg); color: var(--text); font-size: 12.5px;
    outline: none; font-family: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  .history-search input:focus {
    border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .history-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
  .history-group-label {
    font-size: 10.5px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.06em;
    padding: 6px 6px 2px;
  }

  .session-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 11px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background .15s, border-color .15s;
    user-select: none;
  }
  .session-item:hover { background: var(--bg); border-color: var(--border); }
  .session-item.active { background: var(--bg); border-color: var(--accent); }
  .session-info { min-width: 0; flex: 1; margin-right: 8px; }
  .session-title {
    font-size: 13px; font-weight: 500; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .session-meta {
    font-size: 10.5px; color: var(--muted); margin-top: 2px;
    display: flex; align-items: center; gap: 6px;
  }
  .session-item .open {
    flex: 1; text-align: left; border: none; background: transparent;
    color: var(--text); cursor: pointer; padding: 0; margin: 0;
    display: grid; gap: 2px; font: inherit;
  }
  .session-item .open:hover { color: var(--text); }
  .session-del-btn {
    opacity: 0; width: 24px; height: 24px; border-radius: 6px;
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
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    display: flex; flex-direction: column; gap: 6px;
  }
  .clear-all-btn {
    width: 100%; padding: 8px 12px; border-radius: var(--radius-sm);
    border: 1px solid transparent; background: transparent;
    color: var(--danger); font-size: 12.5px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    transition: background .15s;
  }
  .clear-all-btn:hover { background: var(--danger-soft); }

  /* ---------- settings modal ---------- */
  .modal {
    position: fixed; inset: 0; background: rgba(0,0,0,.65);
    display: none; align-items: center; justify-content: center;
    z-index: 40; padding: 18px;
    backdrop-filter: blur(3px);
  }
  .modal.open { display: flex; }
  .modal-card {
    width: 100%; max-width: 360px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px;
    display: grid; gap: 8px;
    box-shadow: 0 12px 40px rgba(0,0,0,.28);
  }
  .modal-header {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
  }
  .modal-title { font-size: 14px; font-weight: 600; margin-bottom: 0; }
  .modal-subtitle { font-size: 11.5px; color: var(--muted); line-height: 1.35; }
  .modal-section {
    display: grid; gap: 6px;
    padding: 2px 0;
  }
  .modal-section + .modal-section {
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .modal-section-title {
    font-size: 11px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--muted);
  }
  .modal-card input, .modal-card select {
    width: 100%; padding: 9px 11px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-size: 13px; color: var(--text); background: var(--bg);
    outline: none; font-family: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  .modal-card input:focus, .modal-card select:focus {
    border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .modal-actions { display: flex; gap: 8px; margin-top: 4px; }
  .field { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
  .field span { font-weight: 500; color: var(--text); }
  .input-row { display: flex; gap: 8px; align-items: center; }
  .input-row input { flex: 1; }
  .input-row .icon-btn { flex: 0 0 auto; padding: 8px 10px; }

  .btn {
    flex: 1; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2); color: var(--text); font-size: 13px; cursor: pointer;
    transition: background .15s, border-color .15s;
  }
  .btn:hover { background: var(--surface-3); }
  .btn.primary { background: var(--accent); color: #fff; border: none; font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); }

  .empty { color: var(--muted); }

  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }
  .confirm-dialog {
    width: min(360px, calc(100vw - 32px));
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 18px 14px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  }
  .confirm-dialog h3 {
    margin: 0 0 6px;
    font-size: 15px;
    color: var(--text);
  }
  .confirm-dialog p {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .approval-hint {
    margin-top: 8px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.35;
  }
  .btn-ghost {
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    border-radius: 8px;
    padding: 7px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .btn-danger {
    border: 1px solid var(--danger);
    background: var(--danger);
    color: #fff;
    border-radius: 8px;
    padding: 7px 12px;
    font-size: 13px;
    cursor: pointer;
  }

  .session-item.erasing {
    position: relative;
    overflow: hidden;
    animation: erase-wipe 0.5s ease forwards;
    pointer-events: none;
    filter: blur(0px);
  }
  .session-item.erasing .session-title,
  .session-item.erasing .session-meta {
    animation: erase-text 0.5s ease forwards;
  }
  .session-item.erasing::before {
    /* Soft smoke/cloud swipe produced by the eraser. */
    content: '';
    position: absolute;
    inset: -8px -16px;
    background: radial-gradient(circle at 30% 50%,
      rgba(255, 255, 255, 0.45) 0%,
      rgba(255, 255, 255, 0.22) 22%,
      rgba(255, 255, 255, 0.08) 45%,
      transparent 68%);
    filter: blur(10px);
    opacity: 0;
    transform: scale(0.85);
    animation: eraser-smoke 0.5s ease forwards;
    z-index: 1;
    pointer-events: none;
  }
  /* no icon here — kept as pure smoke/cloud swipe animation */
  .session-del-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  @keyframes erase-wipe {
    0% { opacity: 1; transform: translateX(0); filter: blur(0px); }
    35% { opacity: 0.85; transform: translateX(-2px); filter: blur(1.2px); }
    70% { opacity: 0.45; transform: translateX(-6px); filter: blur(3px); }
    100% { opacity: 0; transform: translateX(-12px); filter: blur(6px); max-height: 0; margin: 0; padding: 0; }
  }
  @keyframes erase-text {
    0% { opacity: 1; filter: blur(0px); text-decoration: none; }
    30% { opacity: 0.9; filter: blur(0.8px); text-decoration: line-through; }
    100% { opacity: 0; filter: blur(4px); }
  }
  @keyframes eraser-smoke {
    0% { opacity: 0; transform: translateX(-70%) scale(0.7); }
    30% { opacity: 0.55; transform: translateX(-25%) scale(0.95); }
    60% { opacity: 0.75; transform: translateX(15%) scale(1.15); }
    100% { opacity: 0; transform: translateX(70%) scale(1.35); }
  }

  .field.checkbox { flex-direction: row; align-items: center; gap: 8px; flex-wrap: wrap; }
  .field.checkbox input { width: 16px; height: 16px; }
  .field-hint { width: 100%; margin-left: 24px; font-size: 10.5px; color: var(--muted); }
</style>

