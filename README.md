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

## Develop

```bash
npm install
npm run dev        # WXT dev build with reload
npm test           # vitest unit tests (core + OpenAI client, all offline)
npm run typecheck  # wxt prepare + tsc --noEmit (strict)
npm run build      # production build into .output/
```

Load it in Chrome: `chrome://extensions` → Developer mode → Load unpacked →
select `.output/chrome-mv3`. Click the toolbar icon, paste your API key,
type a goal for the active tab, Run.

## Tests

- `tests/*.test.ts` — unit tests with fakes for every port (FakeDriver,
  ScriptedLlm, fake fetch). No network, no API key, deterministic.
- `tests/fixtures/*.html` — nasty-case pages (React-like controlled input,
  async modal + infinite scroll, shadow DOM).
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
