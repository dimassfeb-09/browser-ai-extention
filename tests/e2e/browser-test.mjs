/**
 * Real-browser E2E for the built extension (.output/chrome-mv3):
 *   Part A — content script via real extension messaging:
 *            observe/act on the react-form, shadow-dom and dynamic-list
 *            fixtures (React-style typing must land in the app state).
 *   Part B — the whole loop through the actual side-panel UI, driven by
 *            a deterministic fake OpenAI server (rule-based on the
 *            snapshot text): settings -> client -> driver -> page.
 * Run: npm run test:browser   (needs a display or Xvfb; headed Chromium
 * is required for extensions)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extPath = path.join(root, 'output/chrome-mv3');
const fixturesDir = path.join(root, 'tests/fixtures');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture server ----------
const fixtureServer = http.createServer((req, res) => {
  const file = path.join(fixturesDir, decodeURIComponent(req.url.split('?')[0].slice(1)));
  if (!file.startsWith(fixturesDir) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;

// ---------- fake OpenAI server (deterministic, snapshot-driven) ----------
function fakeDecision(userContent) {
  // Cross-run memory check: a follow-up run's prompt must carry the
  // earlier exchange under "Conversation so far" — answer FROM it.
  if (
    userContent.includes('Conversation so far') &&
    userContent.includes('USER: Subscribe with test@example.com')
  ) {
    return {
      type: 'done',
      summary: 'Recalled from this chat: you asked to subscribe test@example.com and it completed.',
    };
  }
  if (userContent.includes('subscribed:')) {
    return { type: 'done', summary: 'Email filled and subscribed.' };
  }
  const emailLine = userContent
    .split('\n')
    .find((l) => l.includes('<input') && l.includes('you@example.com'));
  const emailIndex = emailLine ? Number(emailLine.match(/\[(\d+)\]/)[1]) : null;
  if (emailLine && emailLine.includes('value="test@example.com"')) {
    const btnLine = userContent
      .split('\n')
      .find((l) => l.includes('<button>') && l.includes('"Subscribe"'));
    return { type: 'click', index: Number(btnLine.match(/\[(\d+)\]/)[1]) };
  }
  return { type: 'type', index: emailIndex, text: 'test@example.com' };
}
const llmServer = http.createServer((req, res) => {
  // The side panel fetches cross-origin from a chrome-extension:// page;
  // without CORS headers (and an OPTIONS answer) the browser blocks it,
  // exactly like a real custom endpoint would without host permissions.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const user = parsed.messages.find((m) => m.role === 'user').content;
    const args = fakeDecision(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'browser_action', arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
  });
});
await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
const llmBase = `http://127.0.0.1:${llmServer.address().port}/v1`;

// ---------- launch Chromium with the extension ----------
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waa-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--no-first-run',
    '--window-size=1280,900',
  ],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = sw.url().split('/')[2];
  check('extension service worker registered', Boolean(extensionId), extensionId);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  async function tabIdFor(urlPart) {
    return panel.evaluate(async (part) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url && t.url.includes(part))?.id ?? null;
    }, urlPart);
  }
  async function send(tabId, msg) {
    return panel.evaluate(
      async ({ tabId, msg }) => chrome.tabs.sendMessage(tabId, msg),
      { tabId, msg },
    );
  }
  async function observe(tabId, tries = 40) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await send(tabId, { kind: 'waa:observe' });
        if (res?.kind === 'waa:snapshot' && res.snapshot.elements.length > 0) return res.snapshot;
      } catch (err) {
        lastErr = err;
      }
      await sleep(300);
    }
    throw new Error(`observe never succeeded: ${lastErr ?? 'no elements'}`);
  }

  // ---------- Part A1: react-form (typing must reach the app state) ----------
  const pageA = await context.newPage();
  await pageA.goto(`${fixtureBase}/react-form.html`);
  const tabA = await tabIdFor('react-form');
  const snapA = await observe(tabA);
  const email = snapA.elements.find((e) => e.tag === 'input' && e.placeholder === 'you@example.com');
  const subscribe = snapA.elements.find((e) => e.tag === 'button' && e.label === 'Subscribe');
  check('A1 snapshot has email input + Subscribe button', Boolean(email && subscribe));
  const typeRes = await send(tabA, {
    kind: 'waa:act',
    action: { type: 'type', index: email.index, text: 'test@example.com' },
  });
  check('A1 type action ok', typeRes.result.ok, typeRes.result.message);
  const stateAfterType = await pageA.evaluate(() => document.getElementById('state').textContent);
  check(
    'A1 value landed in React-like app state (native setter works)',
    stateAfterType === 'test@example.com',
    `state=${stateAfterType}`,
  );
  await send(tabA, { kind: 'waa:act', action: { type: 'click', index: subscribe.index } });
  await sleep(200);
  const stateAfterClick = await pageA.evaluate(() => document.getElementById('state').textContent);
  check('A1 subscribe click used the typed state', stateAfterClick === 'subscribed:test@example.com', `state=${stateAfterClick}`);

  // ---------- Part A2: shadow DOM ----------
  const pageB = await context.newPage();
  await pageB.goto(`${fixtureBase}/shadow-dom.html`);
  const tabB = await tabIdFor('shadow-dom');
  const snapB = await observe(tabB);
  const shadowBtn = snapB.elements.find((e) => e.label === 'Shadow button');
  check('A2 open shadow DOM element appears in snapshot', Boolean(shadowBtn));
  if (shadowBtn) {
    await send(tabB, { kind: 'waa:act', action: { type: 'click', index: shadowBtn.index } });
    await sleep(200);
    const result = await pageB.evaluate(() => document.getElementById('result').textContent);
    check('A2 shadow button click worked', result === 'shadow clicked', `result=${result}`);
  }

  // ---------- Part A3: dynamic content (modal after async click) ----------
  const pageC = await context.newPage();
  await pageC.goto(`${fixtureBase}/dynamic-list.html`);
  const tabC = await tabIdFor('dynamic-list');
  const snapC1 = await observe(tabC);
  check(
    'A3 modal Close absent before opening',
    !snapC1.elements.some((e) => e.label === 'Close'),
  );
  const openBtn = snapC1.elements.find((e) => e.label === 'Open details');
  await send(tabC, { kind: 'waa:act', action: { type: 'click', index: openBtn.index } });
  await sleep(600); // modal appears after 300ms in the fixture
  const snapC2 = await observe(tabC);
  check(
    'A3 fresh snapshot after action sees the async modal',
    snapC2.elements.some((e) => e.label === 'Close'),
  );
  check('A3 list items collected', snapC2.elements.filter((e) => e.label.startsWith('Buy')).length >= 10);

  // ---------- Part B: full loop via the real side-panel UI + fake LLM ----------
  const pageD = await context.newPage();
  await pageD.goto(`${fixtureBase}/react-form.html`);
  await panel.evaluate(async (baseURL) => {
    await chrome.storage.local.set({
      'waa:settings': { apiKey: 'sk-fake', model: 'fake-model', baseURL },
    });
  }, llmBase);
  await panel.reload();
  await panel.waitForFunction(
    () => document.querySelectorAll('input')[1]?.value === 'fake-model',
    { timeout: 10_000 },
  );
  await panel.locator('textarea').fill('Subscribe with test@example.com');
  await pageD.bringToFront(); // the agent must act on the fixture tab, not the panel
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  try {
    await panel.waitForFunction(() => document.body.innerText.includes('Email filled and subscribed.'), { timeout: 30_000 });
  } catch {
    const dump = await panel.evaluate(() => document.body.innerText);
    console.log('PANEL DUMP ON TIMEOUT:\n' + dump);
    throw new Error('UI run did not reach done in 30s');
  }
  const panelText = await panel.evaluate(() => document.body.innerText);
  check('B UI run finished (summary bubble, no status bar)', panelText.includes('Email filled and subscribed.') && !panelText.includes('done —'));
  const finalState = await pageD.evaluate(() => document.getElementById('state').textContent);
  check('B page actually subscribed via the agent loop', finalState === 'subscribed:test@example.com', `state=${finalState}`);

  // B2: follow-up in the SAME chat. Without conversation memory the
  // model cannot know what it did in the previous run (the exact
  // failure seen in the field: "how many did you add?" -> "I only
  // scrolled"). The fake LLM can only produce the recall summary if
  // the history actually reached it.
  await panel.locator('textarea').fill('What did you do earlier in this chat?');
  await pageD.bringToFront();
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await panel.waitForFunction(() => document.body.innerText.includes('Recalled from this chat'), { timeout: 30_000 });
  check('B2 follow-up answered from conversation history (cross-run memory)', true);

  // ---------- Part B3: a run stays pinned to its starting tab ----------
  // Start a run on a fresh fixture tab, then immediately switch to
  // another tab. With dynamic active-tab resolution the agent would
  // follow the user and act on the WRONG page; pinned to the tab that
  // was active at Send, it must finish the original tab's task and
  // leave the tab the user switched to completely untouched.
  await panel.locator('#newChatBtn').click();
  const pageF = await context.newPage();
  await pageF.goto(`${fixtureBase}/react-form.html`);
  await panel.locator('textarea').fill('Subscribe with test@example.com');
  await pageF.bringToFront();
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  // Let the run get going (email typed), THEN the user walks away to
  // another tab — the realistic case. (Hiding a tab mid-initial-load
  // freezes it in headless Chromium; real background tabs keep running,
  // which Part A/B3's later steps exercise: the Subscribe click and the
  // final observe all happen while pageF is in the background.)
  await pageF.waitForFunction(() => document.getElementById('state').textContent === 'test@example.com', { timeout: 15_000 });
  const pageG = await context.newPage();
  await pageG.goto(`${fixtureBase}/shadow-dom.html`);
  await pageG.bringToFront(); // the user "walks away" to another tab
  await panel.waitForFunction(() => document.body.innerText.includes('Email filled and subscribed.'), { timeout: 30_000 });
  const stateF = await pageF.evaluate(() => document.getElementById('state').textContent);
  check('B3 run finished on its ORIGINAL tab after the user switched away',
    stateF === 'subscribed:test@example.com', `state=${stateF}`);
  const stateG = await pageG.evaluate(() => document.getElementById('result').textContent);
  check('B3 the tab the user switched to was never touched', stateG === 'not clicked', `result=${stateG}`);

  // ---------- Part C: chat history + per-window sessions ----------
  const messagesText = () =>
    panel.evaluate(() => document.querySelector('[data-testid="messages"]').innerText);

  // C1: history persists across a panel reload (same window = same session)
  await panel.reload();
  await panel.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="messages"]')
        .innerText.includes('Subscribe with test@example.com'),
    { timeout: 15_000 },
  );
  const afterReload = await messagesText();
  check(
    'C1 chat history survives panel reload',
    afterReload.includes('Subscribe with test@example.com') &&
      afterReload.includes('Email filled and subscribed.'),
  );

  // C2: + New chat starts empty; the old chat is in History and reopens
  await panel.locator('button[title="New chat"]').click();
  await sleep(400);
  const emptyText = await messagesText();
  check('C2 new chat starts empty', emptyText.includes('No messages yet'));
  await panel.locator('button[title="Chat history"]').click();
  await panel.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="history"]')
        .innerText.includes('Subscribe with test@example.com'),
    { timeout: 10_000 },
  );
  check('C2 old chat listed in History with its goal as title', true);
  // Two sessions now share this goal title (Part B's, with the B2
  // follow-up = 4 messages, and B3's = 2). Reopen Part B's: it is the
  // one whose summary the next check looks for.
  await panel
    .locator('[data-testid="history"] .open', { hasText: '4 messages' })
    .click();
  await sleep(400);
  const reopened = await messagesText();
  check('C2 reopening a history chat restores its messages', reopened.includes('Email filled and subscribed.'));

  // C3: a NEW browser window gets its OWN session (history still shared)
  const mainWindowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const newPagePromise = context.waitForEvent('page', { timeout: 15_000 });
  await panel.evaluate(async (url) => {
    await chrome.windows.create({ url });
  }, `${fixtureBase}/react-form.html`);
  const win2Page = await newPagePromise;
  await win2Page.waitForLoadState('domcontentloaded');
  await win2Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await win2Page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="messages"]')
        ?.innerText.includes('No messages yet'),
    { timeout: 15_000 },
  );
  const win2WindowId = await win2Page.evaluate(async () => (await chrome.windows.getCurrent()).id);
  check(
    'C3 new window = new empty session (own window session)',
    win2WindowId !== mainWindowId,
    `main=${mainWindowId} new=${win2WindowId}`,
  );
  await win2Page.locator('button[title="Chat history"]').click();
  await win2Page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="history"]')
        .innerText.includes('Subscribe with test@example.com'),
    { timeout: 10_000 },
  );
  check('C3 history list is shared across windows', true);
  await win2Page.close();
} finally {
  await context.close();
  fixtureServer.close();
  llmServer.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL BROWSER TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
