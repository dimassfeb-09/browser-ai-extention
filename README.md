# Web Automation Agent — browser extension

An AI agent that lives in your own browser: give it a goal in the side-panel
chat, it observes the active tab and acts step by step (click, type, scroll,
navigate) until the goal is done — asking you when it hits something only a
human can do (captcha, OTP, payment).

- **Brain:** OpenAI chat completions + tool calling (`browser_action`), BYOK.
  Any OpenAI-compatible endpoint works via the Base URL setting.
- **Harness:** this extension. The LLM only ever sees a JSON snapshot of the
  page and proposes one validated action at a time.
- **Standalone:** no backend, no relation to any other project. The API key
  lives in `chrome.storage.local` on your machine only.
- **Chat system (ChatGPT/Gemini-style):** conversations are sessions with a
  message history (your goal as a bubble, the agent's summary + collapsible
  step log as the reply), stored in `chrome.storage.local` so they survive
  reloads and browser restarts. The ☰ history lists every session
  (title = first goal, delete supported). **Sessions are bound per window:**
  `byWindow` maps each Chrome window to its own active session — a new
  window starts a fresh chat, each window resumes where it left off, and
  any window can open any session from the shared history.

## Architecture (ports & adapters)

```
src/core/      Pure logic. Zero imports of chrome / DOM / OpenAI.
               types, ports, agent loop (state machine), snapshot
               cleaning + fingerprinting, actuator escalation policy,
               zod tool schemas, prompts.
src/adapters/  openai/  — thin chat-completions client over fetch
               chrome/  — tab content driver, message protocol, settings
entrypoints/   content.ts   — the only DOM code: collector + actuator
               background.ts — opens the side panel
               sidepanel/   — Svelte chat UI (render + intents only)
```

Key decision: the content script converts the live DOM into a serializable
`PageSnapshot` (indexed interactive elements with fingerprints). Everything
above that works on plain JSON and is unit-testable without a browser.

### How dynamic pages are handled

- **Fresh snapshot after every action** — indices are never trusted across steps.
- **React/Vue typing** — the actuator sets values via the prototype's native
  setter + `input`/`change` events (bypasses React's value tracker), verifies
  the value stuck, then escalates: per-character event sequence → `execCommand`.
- **Stuck detection** — 3 identical page hashes in a row stops the loop instead
  of burning tokens.
- **Shadow DOM** — the collector walks open shadow roots.
- **Human handoff** — `ask_user` pauses the run for captcha/OTP/payment.
- **Tab pinning** — a run is locked to the tab that was active when you
  pressed Send. Switch tabs or windows freely while it works; the agent
  will not follow you. If you close the target tab, the run errors out
  instead of jumping to another tab.
- **Per-tab panel & chats** — the side panel itself is per tab too:
  the background script keeps it disabled by default and enables it
  only for the tab where you click the toolbar icon, so it never
  follows you to other tabs. Each tab also owns its chat session —
  the panel shows the chat of the tab you're looking at, and switching
  tabs switches chats (all sessions stay in the shared history, and
  opening one from history binds it to the current tab).
- **Slash commands** — handled locally in the panel, never sent to the
  page agent: `/help`, `/new`, `/reset` (wipe this chat, keep the
  session), `/clear`, `/compact` (fold the chat so far into an
  LLM-written summary the agent keeps as its memory), `/stop`,
  `/retry`, `/model <name>`, `/settings`, `/export` (download the chat
  as Markdown), `/recipe` (save, run, list or delete reusable goals).
  Typing `/` shows a suggestion menu.
- **Step budget** — configurable per run in Settings ("Max steps per
  run", default 100, 0 = no limit). Long runs get a checkpoint notice
  every 25 steps instead of a surprise stop, and hitting the budget
  reports the progress made. The stuck/repetition guards and the Stop
  button apply at any budget. Observations wait for the DOM to settle
  (~250 ms polls) so mid-render snapshots stop producing stale indices.
- **Conversation memory** — every run receives the chat's earlier goals
  plus the agent's own results and action digests ("Conversation so
  far"), so follow-ups like "how many did you add?" are answered from
  what the agent actually did, not guessed from the page. Within a run,
  recent steps are rendered with their payloads (typed text included),
  a harness notice fires when the page navigates (a submit likely
  completed the goal), and the system prompt requires doing the task
  exactly as many times as asked — one "fill" goal no longer produces
  three saved records.
- **Iframes** — the content script runs in all frames; the driver merges
  per-frame snapshots into one and routes actions back by frameId.
- **Forms** — `<select>` accepts the option's visible text or value;
  field labels come from real `<label>` associations, not just the
  control's own text.
- **Grids** — snapshot lines carry row context (`ctx="USR-023 …"`) so
  identical per-row buttons (Edit/Delete) are distinguishable.
- **Hard widgets** — masked inputs (phone/Rupiah) verify digit-tolerantly
  instead of failing on reformatting; OTP split boxes distribute one
  typed code across the boxes; canvas/tabindex widgets get a real
  per-character keyboard sequence, and `click_at` clicks coordinates
  inside an element for canvas regions.

## Develop

```bash
npm install
npm run dev        # WXT dev build with reload
npm test           # vitest unit tests (core + OpenAI client, all offline)
npm run typecheck  # wxt prepare + tsc --noEmit (strict)
npm run build      # production build into output/
```

Load it in Chrome: `chrome://extensions` → Developer mode → Load unpacked →
select `output/chrome-mv3`. Click the toolbar icon, paste your API key,
type a goal for the active tab, Run.

## Tests

- `tests/*.test.ts` — unit tests with fakes for every port (FakeDriver,
  ScriptedLlm, fake fetch). No network, no API key, deterministic.
- `tests/fixtures/*.html` — nasty-case pages (React-like controlled input,
  async modal + infinite scroll, shadow DOM).
- `tests/playground/*.html` + `tests/e2e/forms-test.mjs`
  (`npm run test:forms`) — a no-DB playground of **real React 18 and
  Vue 3 apps** plus vanilla pages covering the nasty cases: controlled
  forms, separate `<label for>` fields, modal forms, dynamic rows,
  custom dropdowns, switches, date inputs, contenteditable, range,
  autocomplete, multi-step wizards, and a form inside an iframe.
  Scenarios drive the real content script and assert each page's own end
  state. Batch 2 (`npm run test:forms2`, same playground) covers the
  shapes that usually break automation: a paginated editable grid,
  native `<dialog>`, a custom confirm dialog, masked phone/currency
  inputs, OTP split boxes, a calendar date picker, a canvas-rendered
  form, and a form inside shadow DOM. Verified 30/30 total on
  2026-10-21 — the shadow case caught (and fixed) a real indexing bug
  where two shadow inputs shared one cssPath and actions landed on the
  wrong field.
- `tests/e2e/browser-test.mjs` (`npm run test:browser`, needs Xvfb/a display) —
  loads the **built** extension into real Chromium via Playwright. Part A
  drives the content script through real extension messaging (typing must
  land in the React-like app state, shadow-DOM clicks, async modal).
  Part B runs the whole loop through the actual side-panel UI against a
  deterministic fake OpenAI server. Part C covers the chat system:
  history surviving a panel reload, New chat starting empty, reopening a
  chat from History, and a second browser window getting its own fresh
  session while sharing the history list. Verified 18/18 on 2026-10-21 — it
  immediately caught a real bug the unit tests missed (a stored bare
  `fetch` reference throwing "Illegal invocation"), which is the point.
  Note: the fake LLM server sends CORS headers; a real custom Base URL
  endpoint needs the same, or a matching `host_permissions` entry.

Every run can be traced: the side panel logs each observe/action/result;
save that trace and it becomes a replayable fixture for a regression test.
