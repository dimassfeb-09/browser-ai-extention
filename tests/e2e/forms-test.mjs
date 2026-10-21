/**
 * Forms playground E2E: real React 18 / real Vue 3 / vanilla pages with
 * nasty form conditions (controlled inputs, separate <label for>, modal
 * forms, dynamic rows, custom dropdowns, contenteditable, range,
 * autocomplete, multi-step wizard, iframe form). The extension's content
 * script is driven through real extension messaging, exactly the way
 * the agent loop drives it, and every scenario asserts the PAGE's own
 * end state — not mocks.
 * Run: npm run test:forms   (needs Xvfb/a display, headed Chromium)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extPath = path.join(root, 'output/chrome-mv3');
const playgroundDir = path.join(root, 'tests/playground');
const vendor = {
  '/vendor/react.js': 'node_modules/react/umd/react.production.min.js',
  '/vendor/react-dom.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  '/vendor/vue.js': 'node_modules/vue/dist/vue.global.prod.js',
};

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (vendor[urlPath]) {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(root, vendor[urlPath])));
    return;
  }
  const file = path.join(playgroundDir, urlPath.slice(1));
  if (!file.startsWith(playgroundDir) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waa-forms-'));
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
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  async function tabIdFor(part) {
    return panel.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url && t.url.includes(p))?.id ?? null;
    }, part);
  }
  async function send(tabId, msg, frameId) {
    return panel.evaluate(
      async ({ tabId, msg, frameId }) =>
        frameId === undefined
          ? chrome.tabs.sendMessage(tabId, msg)
          : chrome.tabs.sendMessage(tabId, msg, { frameId }),
      { tabId, msg, frameId },
    );
  }
  async function observe(tabId, { frameId, tries = 40, allowEmpty = false } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await send(tabId, { kind: 'waa:observe' }, frameId);
        if (res?.kind === 'waa:snapshot' && (allowEmpty || res.snapshot.elements.length > 0)) {
          return res.snapshot;
        }
      } catch (err) {
        lastErr = err;
      }
      await sleep(300);
    }
    throw new Error(`observe failed: ${lastErr ?? 'no elements'}`);
  }
  function findEl(snap, pred, desc) {
    const el = snap.elements.find(pred);
    if (!el) {
      throw new Error(
        `element not found: ${desc}. Snapshot: ${snap.elements.map((e) => `[${e.index}]<${e.tag}>${JSON.stringify(e.label)}`).join(' ')}`,
      );
    }
    return el;
  }
  const byLabel = (label) => (e) => e.label === label;
  async function act(tabId, snap, pred, desc, action, frameId) {
    const el = findEl(snap, pred, desc);
    const res = await send(tabId, { kind: 'waa:act', action: { ...action, index: el.index } }, frameId);
    if (!res?.result?.ok) throw new Error(`act ${desc} failed: ${res?.result?.message ?? JSON.stringify(res)}`);
    return res.result;
  }
  const type = (tabId, snap, pred, desc, text, frameId) =>
    act(tabId, snap, pred, desc, { type: 'type', text }, frameId);
  const click = (tabId, snap, pred, desc, frameId) =>
    act(tabId, snap, pred, desc, { type: 'click' }, frameId);
  async function openPage(file) {
    const page = await context.newPage();
    await page.goto(`${base}/${file}`);
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  // ---------- R1: React controlled registration form ----------
  {
    const page = await openPage('react-basic.html');
    await page.waitForFunction(() => document.querySelectorAll('input,select,textarea,button').length >= 6);
    const tab = await tabIdFor('react-basic');
    let snap = await observe(tab);
    await type(tab, snap, byLabel('Nama Lengkap'), 'nama', 'Budi Santoso');
    await type(tab, snap, byLabel('Email'), 'email', 'budi@example.com');
    await type(tab, snap, byLabel('Negara'), 'negara (select by visible text)', 'Indonesia');
    await click(tab, snap, byLabel('Setuju syarat dan ketentuan'), 'checkbox setuju');
    await type(tab, snap, byLabel('Bio'), 'bio', 'Halo dunia');
    snap = await observe(tab);
    await click(tab, snap, byLabel('Daftar'), 'submit');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('R1 React controlled form submits with agent-filled values',
      result.includes('name=Budi Santoso') && result.includes('email=budi@example.com') &&
      result.includes('country=ID') && result.includes('agree=yes') && result.includes('bio=Halo dunia'),
      result);
  }

  // ---------- R2: React dynamic list + modal form ----------
  {
    const page = await openPage('react-dynamic.html');
    await page.waitForFunction(() => document.querySelectorAll('button').length >= 1);
    const tab = await tabIdFor('react-dynamic');
    let snap = await observe(tab);
    await click(tab, snap, byLabel('Tambah Item'), 'open modal');
    await sleep(400);
    snap = await observe(tab);
    await type(tab, snap, byLabel('Nama Item'), 'nama item', 'Apel');
    await type(tab, snap, byLabel('Qty'), 'qty', '3');
    await click(tab, snap, byLabel('Simpan'), 'simpan modal');
    await sleep(400);
    snap = await observe(tab);
    const items = await page.evaluate(() => document.getElementById('items')?.textContent ?? '');
    const count = await page.evaluate(() => document.getElementById('count')?.textContent ?? '');
    check('R2 React modal form adds the item', items.includes('Apel x3') && count.includes('Total: 1 item'), `${items} / ${count}`);
    check('R2 modal is closed afterwards (fields gone from snapshot)',
      !snap.elements.some((e) => e.label === 'Nama Item'));
  }

  // ---------- V1: Vue v-model form ----------
  {
    const page = await openPage('vue-basic.html');
    await page.waitForFunction(() => document.querySelectorAll('input,select').length >= 5);
    const tab = await tabIdFor('vue-basic');
    let snap = await observe(tab);
    await type(tab, snap, byLabel('Nama'), 'nama', 'Sari');
    await type(tab, snap, byLabel('Email'), 'email', 'sari@example.com');
    await type(tab, snap, byLabel('Negara'), 'negara', 'Malaysia');
    await click(tab, snap, byLabel('Pro'), 'radio pro');
    await type(tab, snap, byLabel('Bio'), 'bio', 'Vue bio');
    await click(tab, snap, byLabel('Setuju'), 'checkbox setuju');
    snap = await observe(tab);
    await click(tab, snap, byLabel('Kirim'), 'submit');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('V1 Vue v-model form submits with agent-filled values',
      result.includes('name=Sari') && result.includes('country=MY') && result.includes('plan=pro') &&
      result.includes('agree=yes') && result.includes('bio=Vue bio'),
      result);
  }

  // ---------- V2: Vue custom dropdown + switch + date ----------
  {
    const page = await openPage('vue-custom.html');
    await page.waitForFunction(() => document.querySelectorAll('button').length >= 2);
    const tab = await tabIdFor('vue-custom');
    let snap = await observe(tab);
    await click(tab, snap, byLabel('Pilih kota'), 'open dropdown');
    await sleep(300);
    snap = await observe(tab);
    await click(tab, snap, byLabel('Bandung'), 'pick Bandung');
    snap = await observe(tab);
    await click(tab, snap, (e) => e.role === 'switch', 'switch notifikasi');
    await type(tab, snap, byLabel('Tanggal'), 'tanggal', '2026-01-15');
    snap = await observe(tab);
    await click(tab, snap, byLabel('Simpan'), 'simpan');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('V2 Vue custom dropdown + switch + date saved',
      result.includes('city=Bandung') && result.includes('notif=on') && result.includes('date=2026-01-15'),
      result);
  }

  // ---------- M1: vanilla modal with <label for> fields ----------
  {
    const page = await openPage('vanilla-modal.html');
    const tab = await tabIdFor('vanilla-modal');
    let snap = await observe(tab);
    await click(tab, snap, byLabel('Buka Form'), 'open modal');
    await sleep(300);
    snap = await observe(tab);
    await type(tab, snap, byLabel('Nama'), 'nama (label-for)', 'Dewi');
    await type(tab, snap, byLabel('Email'), 'email', 'dewi@example.com');
    await type(tab, snap, byLabel('Kota'), 'kota select', 'Semarang');
    await click(tab, snap, byLabel('Simpan'), 'simpan');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('M1 modal form with separate <label for> fields submits',
      result.includes('nama=Dewi') && result.includes('email=dewi@example.com') && result.includes('kota=SMG'),
      result);
  }

  // ---------- C1: custom controls ----------
  {
    const page = await openPage('custom-controls.html');
    const tab = await tabIdFor('custom-controls');
    let snap = await observe(tab);
    await type(tab, snap, byLabel('Catatan'), 'contenteditable', 'Isi catatan penting');
    await click(tab, snap, byLabel('Simpan Catatan'), 'simpan catatan');
    const note = await page.evaluate(() => document.getElementById('noteResult')?.textContent ?? '');
    check('C1 contenteditable typed via execCommand path', note === 'NOTE: Isi catatan penting', note);

    snap = await observe(tab);
    await click(tab, snap, byLabel('Pilih warna'), 'open custom dropdown');
    await sleep(200);
    snap = await observe(tab);
    await click(tab, snap, byLabel('Biru'), 'pick Biru');
    const dd = await page.evaluate(() => document.getElementById('ddValue')?.textContent ?? '');
    check('C1 custom div dropdown selects', dd === 'Biru', dd);

    snap = await observe(tab);
    await type(tab, snap, byLabel('Volume'), 'range slider', '80');
    const vol = await page.evaluate(() => document.getElementById('volOut')?.textContent ?? '');
    check('C1 range slider set to 80', vol === '80', vol);

    snap = await observe(tab);
    await type(tab, snap, byLabel('Buah'), 'autocomplete input', 'Ap');
    await sleep(300);
    snap = await observe(tab);
    await click(tab, snap, byLabel('Apel'), 'suggestion Apel');
    const ac = await page.evaluate(() => document.getElementById('acValue')?.textContent ?? '');
    check('C1 autocomplete suggestion picked', ac === 'Apel', ac);

    snap = await observe(tab);
    await click(tab, snap, byLabel('Tambah Baris'), 'add row 1');
    snap = await observe(tab);
    await click(tab, snap, byLabel('Tambah Baris'), 'add row 2');
    snap = await observe(tab);
    const rows = snap.elements.filter((e) => (e.placeholder ?? '').startsWith('Baris'));
    const rowCount = await page.evaluate(() => document.getElementById('rowCount')?.textContent ?? '');
    check('C1 dynamic rows appear in fresh snapshots', rows.length === 2 && rowCount.includes('2'), `${rows.length} rows`);
  }

  // ---------- W1: multi-step wizard ----------
  {
    const page = await openPage('wizard.html');
    const tab = await tabIdFor('wizard');
    let snap = await observe(tab);
    await type(tab, snap, byLabel('Nama'), 'nama', 'Rina');
    await type(tab, snap, byLabel('Kota'), 'kota', 'Depok');
    await click(tab, snap, byLabel('Lanjut'), 'next step');
    await sleep(300);
    snap = await observe(tab);
    check('W1 step 2 replaces step 1 in the snapshot',
      snap.elements.some((e) => e.label === 'Email') && !snap.elements.some((e) => e.label === 'Kota'));
    await type(tab, snap, byLabel('Email'), 'email', 'rina@example.com');
    await type(tab, snap, byLabel('Telepon'), 'telepon', '08123456789');
    await click(tab, snap, byLabel('Kirim'), 'submit wizard');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('W1 wizard completes across steps',
      result.includes('nama=Rina') && result.includes('email=rina@example.com') && result.includes('tel=08123456789'),
      result);
  }

  // ---------- F1: form inside an iframe (per-frame messaging) ----------
  {
    const page = await openPage('iframe-form.html');
    await page.waitForFunction(() => document.querySelector('iframe'));
    await sleep(800);
    const tab = await tabIdFor('iframe-form');
    const frameId = await panel.evaluate(async (tabId) => {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return frames.find((f) => f.url.includes('form-inner'))?.frameId ?? null;
    }, tab);
    check('F1 inner frame discovered via webNavigation', typeof frameId === 'number', `frameId=${frameId}`);
    // NOTE: messaging without a frameId broadcasts to all frames now that
    // the content script runs allFrames — always address frames explicitly.
    const topSnap = await observe(tab, { frameId: 0, allowEmpty: true });
    check('F1 top-frame snapshot does NOT contain the inner form fields',
      !topSnap.elements.some((e) => e.label === 'Kode Voucher'),
      `${topSnap.elements.length} top elements`);
    let snap = await observe(tab, { frameId });
    await type(tab, snap, byLabel('Kode Voucher'), 'kode voucher (in iframe)', 'XYZ123', frameId);
    snap = await observe(tab, { frameId });
    await click(tab, snap, byLabel('Proses'), 'proses (in iframe)', frameId);
    await sleep(300);
    const frame = page.frame({ url: /form-inner/ });
    const result = await frame.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('F1 iframe form filled + submitted via its own frame', result === 'INNER OK kode=XYZ123', result);
  }
} finally {
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL FORM TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
