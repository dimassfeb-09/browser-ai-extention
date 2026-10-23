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
import { createWorker } from 'tesseract.js';

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
    (userContent.includes('USER: Subscribe with test@example.com') ||
      // After /compact the raw exchange is gone; the pinned summary
      // turn is the only memory — recalling from it must still work.
      userContent.includes('[Compacted summary of the earlier conversation]'))
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
// OCR for Part E: the fake "vision model" genuinely reads the
// question out of the screenshot pixels the agent sends — the quiz
// fixture keeps the question ONLY in the image, so there is no other
// channel. Local traineddata (devDependency), no network at runtime.
const ocrLangPath = path.join(root, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int');
let ocrWorker = null;
let imageSeenCount = 0;
let lastQuizImage = null;
async function ocrImage(dataUrl) {
  ocrWorker ??= await createWorker('eng', 1, {
    langPath: ocrLangPath,
    cacheMethod: 'none',
    logger: () => {},
  });
  const buf = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
  const { data } = await ocrWorker.recognize(buf);
  return data.text;
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
  req.on('end', async () => {
    const parsed = JSON.parse(body);
    if (!parsed.tools) {
      // /compact's summarize call: a plain completion, no tools.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'SUMMARY: The user asked to subscribe with test@example.com; the agent subscribed successfully (subscribed:test@example.com). Nothing pending.',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    const rawContent = parsed.messages.find((m) => m.role === 'user').content;
    const contentParts = Array.isArray(rawContent)
      ? rawContent
      : [{ type: 'text', text: rawContent }];
    const user = contentParts.find((part) => part.type === 'text')?.text ?? '';
    const imagePart = contentParts.find((part) => part.type === 'image_url');
    let args;
    if (user.includes('image-quiz2')) {
      // Part F: two harder questions in one image — a fraction sum
      // and a parenthesized expression — each with its own buttons.
      const q1Done = user.includes('Q1 state: answered:');
      const q2Done = user.includes('Q2 state: answered:');
      const clickLine = (label) => {
        const line = user
          .split('\n')
          .find((l) => l.includes('<button>') && l.includes(`"${label}"`));
        return line
          ? { type: 'click', index: Number(line.match(/\[(\d+)\]/)[1]) }
          : { type: 'done', summary: `No button found for ${label}` };
      };
      if (q1Done && q2Done) {
        args = { type: 'done', summary: 'Both questions answered from the image.' };
      } else if (imagePart) {
        imageSeenCount++;
        lastQuizImage = imagePart.image_url.url;
        const ocr = await ocrImage(imagePart.image_url.url);
        // OCR over the marked JPEG mangles option letters ('C.' comes
        // back as 'Cw' or 'c.'), so options are matched token-wise:
        // a 1-2 char letter token followed by a value token.
        const letterTok = (tok) => tok.match(/^([A-Da-d])[.)]?w?$/)?.[1]?.toUpperCase();
        const letterFracOptions = (text) => {
          const toks = text.split(/\s+/);
          const out = [];
          for (let i = 0; i < toks.length - 1; i++) {
            const L = letterTok(toks[i]);
            const f = toks[i + 1].match(/^(\d+)\/(\d+)$/);
            if (L && f) out.push([L, Number(f[1]), Number(f[2])]);
          }
          return out;
        };
        const letterIntOptions = (text) => {
          const toks = text.split(/\s+/);
          const out = [];
          for (let i = 0; i < toks.length - 1; i++) {
            const L = letterTok(toks[i]);
            const n = toks[i + 1].match(/^(\d+)$/);
            if (L && n) out.push([L, Number(n[1])]);
          }
          return out;
        };
        const q2At = ocr.search(/Q2/i);
        if (!q1Done) {
          // Q1 segment = everything before Q2. Fractions in order:
          // two operands, then the four lettered options.
          const seg = q2At >= 0 ? ocr.slice(0, q2At) : ocr;
          const fracs = [...seg.matchAll(/(\d+)\s*\/\s*(\d+)/g)].map((m) => [
            Number(m[1]),
            Number(m[2]),
          ]);
          const opts = letterFracOptions(seg);
          const [a, b] = fracs;
          const sumN = a[0] * b[1] + b[0] * a[1];
          const sumD = a[1] * b[1];
          const hit = opts.find((o) => o[1] * sumD === sumN * o[2]);
          args = hit
            ? clickLine(`Q1 option ${hit[0]}`)
            : { type: 'done', summary: `Q1 unsolved. OCR: ${ocr.slice(0, 200)}` };
        } else {
          // Q2: evaluate the parenthesized expression, then match the
          // plain-integer options that follow it.
          const seg = q2At >= 0 ? ocr.slice(q2At) : ocr;
          const expr = seg.match(/\([^)]*\)\s*\+\s*\([^)]*\)/)?.[0] ?? '';
          const clean = expr.replace(/x/gi, '*');
          const value = /^[0-9+\-*/(). ]+$/.test(clean)
            ? Function(`"use strict"; return (${clean})`)()
            : null;
          const after = seg.slice(seg.indexOf(expr) + expr.length);
          const hit = letterIntOptions(after).find((o) => o[1] === value);
          args = hit
            ? clickLine(`Q2 option ${hit[0]}`)
            : { type: 'done', summary: `Q2 unsolved (value=${value}). OCR: ${ocr.slice(0, 200)}` };
        }
      } else {
        args = {
          type: 'done',
          summary: 'The questions are inside an image and no screenshot was attached, so I cannot read them.',
        };
      }
    } else if (user.includes('image-quiz')) {
      // Part E: solve from the screenshot pixels, or admit blindness.
      if (user.includes('answered:')) {
        const letter = user.match(/answered:([A-D])/)?.[1] ?? '?';
        args = { type: 'done', summary: `Answered ${letter} based on the image.` };
      } else if (imagePart) {
        imageSeenCount++;
        lastQuizImage = imagePart.image_url.url;
        const ocrText = await ocrImage(imagePart.image_url.url);
        const qm =
          ocrText.match(/(\d+)\s*[×x*]\s*(\d+)/) ?? ocrText.match(/What is (\d+)\D+(\d+)/i);
        const answer = qm ? Number(qm[1]) * Number(qm[2]) : null;
        const hit = [...ocrText.matchAll(/([A-D])\.\s*(\d+)/g)].find(
          (o) => Number(o[2]) === answer,
        );
        const line = hit
          ? user.split('\n').find((l) => l.includes('<button>') && l.includes(`"${hit[1]}"`))
          : null;
        args = line
          ? { type: 'click', index: Number(line.match(/\[(\d+)\]/)[1]) }
          : { type: 'done', summary: `OCR could not solve the question. OCR: ${ocrText.slice(0, 200)}` };
      } else {
        args = {
          type: 'done',
          summary: 'The question is inside an image and no screenshot was attached, so I cannot read it.',
        };
      }
    } else {
      args = fakeDecision(user);
    }
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
  // The settings modal is lazily mounted ({#if open}) — open it like a
  // user would, verify the stored model landed, then close it again.
  await panel.locator('#cfgBtn').click();
  await panel.waitForFunction(
    () => document.querySelector('[data-testid="models"]')?.value === 'fake-model',
    { timeout: 10_000 },
  );
  await panel.keyboard.press('Escape');
  await panel.waitForFunction(() => !document.querySelector('#settingsModal'), { timeout: 5_000 });
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
  // Completion is judged on the PAGE, not the panel: with per-tab
  // sessions the panel is now showing pageG's chat, so pageF's summary
  // bubble is (correctly) not on screen while the user sits on pageG.
  await pageF.waitForFunction(() => document.getElementById('state').textContent === 'subscribed:test@example.com', { timeout: 30_000 });
  const stateF = await pageF.evaluate(() => document.getElementById('state').textContent);
  check('B3 run finished on its ORIGINAL tab after the user switched away',
    stateF === 'subscribed:test@example.com', `state=${stateF}`);
  const stateG = await pageG.evaluate(() => document.getElementById('result').textContent);
  check('B3 the tab the user switched to was never touched', stateG === 'not clicked', `result=${stateG}`);
  // Coming back to pageF, its chat shows the completed run.
  await pageF.bringToFront();
  await panel.waitForFunction(() => document.body.innerText.includes('Email filled and subscribed.'), { timeout: 15_000 });
  check('B3 returning to the tab shows its completed chat', true);

  // ---------- Part C: chat history + per-TAB sessions ----------
  const messagesText = () =>
    panel.evaluate(() => document.querySelector('[data-testid="messages"]').innerText);
  const waitMessages = (text, timeout = 15_000) =>
    panel.waitForFunction(
      (t) => document.querySelector('[data-testid="messages"]').innerText.includes(t),
      text,
      { timeout },
    );

  // C1: the panel view follows the ACTIVE tab — pageF owns the Part
  // B3 session (goal + summary, no follow-up). The 'Recalled' text
  // exists only in pageD's Part B session, so its ABSENCE here proves
  // the panel really switched chats, not just titles.
  await pageF.bringToFront();
  await waitMessages('Email filled and subscribed.');
  const fText = await messagesText();
  check(
    'C1 panel shows the chat of the active tab (Part B3 session on pageF)',
    fText.includes('Email filled and subscribed.') && !fText.includes('Recalled from this chat'),
  );

  // C2: pageD's binding points at the empty session the B3 "New chat"
  // click created while pageD was current — NOT at the Part B session.
  await pageD.bringToFront();
  await waitMessages('No messages yet');
  check('C2 switching tabs switches the chat (pageD binding after its New chat)', true);

  // C2b: a marker posted in pageD's chat must NOT leak into pageG's.
  await panel.locator('textarea').fill('/help');
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await waitMessages('Slash commands (handled locally');
  await pageG.bringToFront();
  await waitMessages('No messages yet');
  const gText = await messagesText();
  check(
    'C2b each tab keeps its OWN chat (no leakage across tabs)',
    !gText.includes('Slash commands'),
  );
  await pageD.bringToFront();
  await waitMessages('Slash commands (handled locally');
  check('C2b returning to a tab restores its chat', true);

  // C3: opening a history chat binds it to the CURRENT tab. Do it
  // from pageG: the Part B session (4 messages) becomes pageG's chat.
  await pageG.bringToFront();
  await waitMessages('No messages yet');
  await panel.locator('button[title="Chat history"]').click();
  await panel.waitForFunction(
    () => document.querySelector('[data-testid="history"]').innerText.includes('this tab'),
    { timeout: 10_000 },
  );
  await panel.locator('[data-testid="history"] .open', { hasText: '4 messages' }).click();
  await waitMessages('Recalled from this chat');
  check('C3 a history chat opened from the drawer binds to the current tab', true);

  // C4: per-tab bindings survive a panel reload (persisted byTab map).
  await panel.reload();
  await waitMessages('Recalled from this chat');
  check('C4 per-tab bindings survive a panel reload', true);

  // ---------- Part D: slash commands ----------
  const sendDraft = async (text) => {
    await panel.locator('textarea').fill(text);
    await panel.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
    });
  };

  // D1: typing '/' opens the suggestion menu.
  await panel.locator('textarea').fill('/');
  await panel.waitForFunction(
    () => document.querySelector('[data-testid="slash-menu"]')?.innerText.includes('/compact'),
    { timeout: 10_000 },
  );
  check('D1 slash suggestion menu appears while typing /', true);
  await panel.locator('textarea').fill('');

  // D2: /help renders the command list locally (no run starts).
  await sendDraft('/help');
  await waitMessages('Slash commands (handled locally');
  check('D2 /help lists the commands as a local notice', true);

  // D3: an unknown command is rejected locally with a warning.
  await sendDraft('/bogus');
  await waitMessages('Unknown command "/bogus"');
  check('D3 unknown slash command is rejected locally', true);

  // D4: /model switches and persists the model.
  await sendDraft('/model fake-model-2');
  await waitMessages('Model switched to "fake-model-2"');
  const storedModel = await panel.evaluate(async () => {
    const s = await chrome.storage.local.get('waa:settings');
    return s['waa:settings']?.model;
  });
  check('D4 /model persists the new model to settings', storedModel === 'fake-model-2', `model=${storedModel}`);
  await sendDraft('/model fake-model');
  await waitMessages('Model switched to "fake-model"');

  // D5: /compact folds a real exchange into an LLM summary, and a
  // follow-up afterwards is still answered — from the summary alone.
  const pageH = await context.newPage();
  await pageH.goto(`${fixtureBase}/react-form.html`);
  await pageH.bringToFront();
  await waitMessages('No messages yet'); // pageH's own fresh session
  await panel.locator('textarea').fill('Subscribe with test@example.com');
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await panel.waitForFunction(() => document.body.innerText.includes('Email filled and subscribed.'), { timeout: 30_000 });
  await sendDraft('/compact');
  await waitMessages('Compacted 2 messages (');
  const compactText = await messagesText();
  check(
    'D5 /compact replaces the exchange with an LLM summary',
    compactText.includes('SUMMARY: The user asked to subscribe with test@example.com'),
  );
  await sendDraft('Tadi lu ngapain aja?');
  await panel.waitForFunction(() => document.body.innerText.includes('Recalled from this chat'), { timeout: 30_000 });
  check('D5 follow-up after /compact is answered from the summary', true);

  // D6: /reset wipes messages + agent memory in place.
  await sendDraft('/reset');
  await waitMessages('Chat cleared');
  const resetText = await messagesText();
  check(
    'D6 /reset clears messages and agent memory in place',
    !resetText.includes('Recalled from this chat') && !resetText.includes('SUMMARY: The user asked'),
  );

  // D7: /new starts a fresh chat with a local notice.
  await sendDraft('/new');
  await waitMessages('New chat started');
  check('D7 /new starts a fresh chat', true);

  // ---------- Part E: image-only question (screenshot vision) ----------
  // The fixture's question and option values exist ONLY as pixels of
  // an image. The fake model reads them via real OCR over the exact
  // screenshot the agent sent — no DOM channel carries the answer.
  const pageI = await context.newPage();
  await pageI.goto(`${fixtureBase}/image-quiz.html`);
  const quizDomText = await pageI.evaluate(() => document.body.innerText);
  check(
    'E0 the answer exists only in the image (DOM carries no option values)',
    !quizDomText.includes('56') && !quizDomText.includes('54'),
    quizDomText.replace(/\n/g, ' ').slice(0, 90),
  );
  await pageI.bringToFront();
  await waitMessages('No messages yet'); // pageI's own fresh session
  const imagesBeforeE1 = imageSeenCount;
  await panel.locator('textarea').fill('Answer the multiple-choice question shown in the image');
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await pageI.waitForFunction(() => document.getElementById('verdict').textContent === 'correct', { timeout: 60_000 });
  check('E1 agent read the question from the image and picked the correct option', true);
  check(
    'E1 the observe request carried a marked screenshot',
    imageSeenCount > imagesBeforeE1,
    `images=${imageSeenCount - imagesBeforeE1}`,
  );

  // E1b: the marks are really drawn at the elements' positions —
  // sample the exact screenshot bytes the fake model received.
  const probe = await pageI.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const btn = document.querySelector('[data-letter="B"]').getBoundingClientRect();
    const scale = img.naturalWidth / window.innerWidth;
    const fontSize = Math.max(11, Math.round(img.naturalWidth / 80));
    const th = fontSize + 6;
    // Scan a horizontal strip through the badge's vertical middle:
    // the fill is solid red, but a single point can land on the white
    // index glyph — a strip count is robust against that.
    const yMid = Math.round(btn.y * scale - th / 2);
    const isRed = (d) => d[0] > 150 && d[1] < 110 && d[2] < 110;
    let reds = 0;
    for (let dx = 1; dx < 44; dx++) {
      const d = ctx.getImageData(Math.round(btn.x * scale) + dx, yMid, 1, 1).data;
      if (isRed(d)) reds++;
    }
    const atControl = [...ctx.getImageData(Math.round(1100 * scale), Math.round(60 * scale), 1, 1).data];
    return { badgeRed: reds >= 3, controlRed: isRed(atControl), reds, atControl };
  }, lastQuizImage);
  check(
    'E1b marks land on the elements (badge pixel probe)',
    probe.badgeRed && !probe.controlRed,
    JSON.stringify(probe),
  );

  // E2: negative control — vision OFF. Same quiz, same fake model, but
  // no screenshot is attached, so the question is unreadable and the
  // quiz must stay unsolved.
  await panel.evaluate(async () => {
    const s = await chrome.storage.local.get('waa:settings');
    await chrome.storage.local.set({ 'waa:settings': { ...s['waa:settings'], vision: false } });
  });
  await panel.reload();
  const pageJ = await context.newPage();
  await pageJ.goto(`${fixtureBase}/image-quiz.html`);
  await pageJ.bringToFront();
  await waitMessages('No messages yet');
  const imagesBeforeE2 = imageSeenCount;
  await panel.locator('textarea').fill('Answer the multiple-choice question shown in the image');
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await panel.waitForFunction(() => document.body.innerText.includes('cannot read it'), { timeout: 30_000 });
  const verdictJ = await pageJ.evaluate(() => document.getElementById('verdict').textContent);
  check(
    'E2 with vision off the image quiz stays unsolved',
    verdictJ === 'pending' && imageSeenCount === imagesBeforeE2,
    `verdict=${verdictJ} images=${imageSeenCount - imagesBeforeE2}`,
  );

  // ---------- Part F: harder image math (fractions + expression) ----------
  // Same pixel-only principle as Part E, two questions in one image:
  // a fraction sum (3/4 + 1/2) and a parenthesized expression
  // ((24/6) + (7x3)). The fake model OCR-reads them and computes.
  // NOTE: Part E's negative control left vision OFF in storage —
  // restore it first.
  await panel.evaluate(async () => {
    const s = await chrome.storage.local.get('waa:settings');
    await chrome.storage.local.set({ 'waa:settings': { ...s['waa:settings'], vision: true } });
  });
  await panel.reload();
  // Wait until the reloaded panel is fully mounted (settings loaded,
  // tab-follow listener live) BEFORE pageK activates — otherwise the
  // activation event races the reload and the panel stays on the
  // previous tab's session.
  await panel.locator('#cfgBtn').click();
  await panel.waitForFunction(
    () => document.querySelector('[data-testid="models"]')?.value,
    { timeout: 10_000 },
  );
  await panel.keyboard.press('Escape');
  await panel.waitForFunction(() => !document.querySelector('#settingsModal'), { timeout: 5_000 });
  const pageK = await context.newPage();
  await pageK.goto(`${fixtureBase}/image-quiz2.html`);
  const quiz2DomText = await pageK.evaluate(() => document.body.innerText);
  check(
    'F0 the harder answers exist only in the image',
    !quiz2DomText.includes('5/4') && !quiz2DomText.includes('25'),
    quiz2DomText.replace(/\n/g, ' ').slice(0, 90),
  );
  await pageK.bringToFront();
  await waitMessages('No messages yet'); // pageK's own fresh session
  const imagesBeforeF = imageSeenCount;
  await panel.locator('textarea').fill('Answer both math questions in the image');
  await panel.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await pageK.waitForFunction(() => document.getElementById('verdict').textContent === 'correct', { timeout: 90_000 });
  check('F1 agent solved the fraction sum AND the expression from the image', true);
  check(
    'F2 the run observed with screenshots while solving',
    imageSeenCount - imagesBeforeF >= 2,
    `images=${imageSeenCount - imagesBeforeF}`,
  );

  // ---------- Part G: ARIA widgets (Google Forms-style choices) ----------
  // Google Forms renders multiple choice as plain divs with
  // role="radio"/"checkbox" (no native input, no tabindex). Before
  // the collector learned those roles, the agent was blind to every
  // option. The fixture mimics the framework: clicks flip
  // aria-checked, radios are group-exclusive.
  const pageAria = await context.newPage();
  await pageAria.goto(`${fixtureBase}/aria-form.html`);
  const tabAria = await tabIdFor('aria-form');
  const snapAria = await observe(tabAria);
  const radiosAria = snapAria.elements.filter((e) => e.role === 'radio');
  const boxesAria = snapAria.elements.filter((e) => e.role === 'checkbox');
  check('G0 snapshot captures div[role=radio] options (Google Forms style)', radiosAria.length === 4, `radios=${radiosAria.length}`);
  check('G0 snapshot captures div[role=checkbox] options', boxesAria.length === 2, `boxes=${boxesAria.length}`);
  const kuningAria = radiosAria.find((e) => e.label === 'Kuning');
  check(
    'G0 a radio carries its question as context (listitem)',
    Boolean(kuningAria?.context?.includes('Warna favorit')),
    kuningAria?.context,
  );
  check(
    'G0 all options start unchecked',
    radiosAria.every((e) => e.checked === false) && boxesAria.every((e) => e.checked === false),
  );
  await send(tabAria, { kind: 'waa:act', action: { type: 'click', index: kuningAria.index } });
  await sleep(200);
  const stateAria = await pageAria.evaluate(() => document.getElementById('state').textContent);
  check('G1 clicking a radio selects it in the page', stateAria.includes('Q1: Kuning'), stateAria);
  const snapAria2 = await observe(tabAria);
  const kuning2 = snapAria2.elements.find((e) => e.role === 'radio' && e.label === 'Kuning');
  const merah2 = snapAria2.elements.find((e) => e.role === 'radio' && e.label === 'Merah');
  check(
    'G1 re-observe reports checked=true on the picked radio only',
    kuning2?.checked === true && merah2?.checked === false,
    `kuning=${kuning2?.checked} merah=${merah2?.checked}`,
  );
  const membacaAria = snapAria2.elements.find((e) => e.role === 'checkbox' && e.label === 'Membaca');
  await send(tabAria, { kind: 'waa:act', action: { type: 'click', index: membacaAria.index } });
  await sleep(200);
  const snapAria3 = await observe(tabAria);
  check(
    'G2 checkbox click toggles its checked state in the snapshot',
    snapAria3.elements.find((e) => e.role === 'checkbox' && e.label === 'Membaca')?.checked === true,
  );

} finally {
  if (ocrWorker) await ocrWorker.terminate();
  await context.close();
  fixtureServer.close();
  llmServer.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL BROWSER TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
