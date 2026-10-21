/**
 * Forms playground E2E — batch 2, the shapes that usually break web
 * automation: paginated editable grids (identical Edit buttons told
 * apart by row context), native <dialog>, custom confirm dialogs,
 * masked inputs (phone/Rupiah), OTP split boxes, a calendar date
 * picker, a canvas-rendered form (no DOM inputs — click_at coordinates
 * + keyboard sequence), and a full form inside shadow DOM.
 * Run: npm run test:forms2   (also run as part of test:forms)
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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waa-forms2-'));
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
  async function send(tabId, msg) {
    return panel.evaluate(async ({ tabId, msg }) => chrome.tabs.sendMessage(tabId, msg), { tabId, msg });
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
    throw new Error(`observe failed: ${lastErr ?? 'no elements'}`);
  }
  function findEl(snap, pred, desc) {
    const el = snap.elements.find(pred);
    if (!el) {
      throw new Error(
        `element not found: ${desc}. Snapshot: ${snap.elements.map((e) => `[${e.index}]<${e.tag}>${JSON.stringify(e.label)} ctx=${JSON.stringify(e.context ?? '')}`).join(' ')}`,
      );
    }
    return el;
  }
  const byLabel = (label) => (e) => e.label === label;
  const byCtx = (label, ctxPart) => (e) => e.label === label && (e.context ?? '').includes(ctxPart);
  async function act(tabId, snap, pred, desc, action) {
    const el = findEl(snap, pred, desc);
    const res = await send(tabId, { kind: 'waa:act', action: { ...action, index: el.index } });
    if (!res?.result?.ok) throw new Error(`act ${desc} failed: ${res?.result?.message ?? JSON.stringify(res)}`);
    return res.result;
  }
  const type = (tabId, snap, pred, desc, text) => act(tabId, snap, pred, desc, { type: 'type', text });
  const click = (tabId, snap, pred, desc) => act(tabId, snap, pred, desc, { type: 'click' });
  const clickAt = (tabId, snap, pred, desc, x, y) => act(tabId, snap, pred, desc, { type: 'click_at', x, y });
  async function openPage(file) {
    const page = await context.newPage();
    await page.goto(`${base}/${file}`);
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  // ---------- G1: paginated grid + inline edit ----------
  {
    const page = await openPage('grid-pagination.html');
    const tab = await tabIdFor('grid-pagination');
    let snap = await observe(tab);
    await click(tab, snap, byLabel('5'), 'page 5');
    await sleep(300);
    snap = await observe(tab);
    check('G1 row context identifies Edit buttons per row',
      snap.elements.some((e) => e.label === 'Edit' && (e.context ?? '').includes('USR-023')));
    await click(tab, snap, byCtx('Edit', 'USR-023'), 'edit USR-023');
    await sleep(300);
    snap = await observe(tab);
    await type(tab, snap, byLabel('Nama USR-023'), 'edit nama', 'Diganti');
    await type(tab, snap, byLabel('Status USR-023'), 'edit status', 'Nonaktif');
    await click(tab, snap, byCtx('Save', 'USR-023'), 'save row');
    await sleep(300);
    const tbody = await page.evaluate(() => document.getElementById('tbody')?.textContent ?? '');
    const info = await page.evaluate(() => document.getElementById('info')?.textContent ?? '');
    check('G1 inline edit on page 5 saved', tbody.includes('Diganti') && tbody.includes('Nonaktif'), tbody.replace(/\s+/g, ' ').slice(0, 120));
    check('G1 still on page 5 after save', info.includes('Halaman 5 dari 5'), info);
  }

  // ---------- D1: native <dialog> ----------
  {
    const page = await openPage('dialog-native.html');
    const tab = await tabIdFor('dialog-native');
    let snap = await observe(tab);
    check('D1 dialog fields are invisible before it opens',
      !snap.elements.some((e) => e.label === 'Kirim'));
    await click(tab, snap, byLabel('Buka Dialog'), 'open dialog');
    await sleep(400);
    snap = await observe(tab);
    await type(tab, snap, byLabel('Nama'), 'nama', 'Eko');
    await type(tab, snap, byLabel('Kota'), 'kota', 'Bogor');
    await click(tab, snap, byLabel('Kirim'), 'submit dialog');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    const open = await page.evaluate(() => document.getElementById('dlg').open);
    check('D1 native <dialog> form submits and closes', result === 'DIALOG OK nama=Eko kota=Bogor' && open === false, result);
  }

  // ---------- D2: custom confirm dialog ----------
  {
    const page = await openPage('dialog-confirm.html');
    const tab = await tabIdFor('dialog-confirm');
    let snap = await observe(tab);
    await click(tab, snap, byLabel('Hapus'), 'hapus');
    await sleep(300);
    snap = await observe(tab);
    await click(tab, snap, byLabel('Ya, Hapus'), 'confirm ya');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    const list = await page.evaluate(() => document.getElementById('list')?.textContent ?? '');
    check('D2 confirm dialog gates the delete, then it happens',
      result === 'Terhapus: Data Toll A' && list.includes('Tidak ada data'), result);
  }

  // ---------- M1: masked inputs + OTP ----------
  {
    const page = await openPage('masked-otp.html');
    const tab = await tabIdFor('masked-otp');
    let snap = await observe(tab);
    await type(tab, snap, byLabel('Telepon'), 'masked phone', '081234567890');
    await type(tab, snap, byLabel('Nominal'), 'masked currency', '1500000');
    const tel = await page.evaluate(() => document.getElementById('tel').value);
    const rp = await page.evaluate(() => document.getElementById('rp').value);
    check('M1 phone mask applied without false failure', tel === '0812-3456-7890', tel);
    check('M1 currency mask applied (1.500.000)', rp === '1.500.000', rp);
    snap = await observe(tab);
    await type(tab, snap, byLabel('OTP 1'), 'otp full code into first box', '123456');
    await click(tab, snap, byLabel('Cek'), 'cek');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('M1 OTP distributed across 6 boxes and valid', result.includes('otp=123456') && result.includes('OTP-VALID'), result);
    check('M1 result carries masked values end-to-end',
      result.includes('tel=0812-3456-7890') && result.includes('rp=1500000'), result);
  }

  // ---------- P1: calendar date picker ----------
  {
    const page = await openPage('datepicker.html');
    const tab = await tabIdFor('datepicker');
    let snap = await observe(tab);
    await click(tab, snap, byLabel('Tanggal Lahir'), 'open calendar');
    await sleep(300);
    snap = await observe(tab);
    await click(tab, snap, byLabel('Bulan berikutnya'), 'next month (Okt -> Nov)');
    await sleep(300);
    snap = await observe(tab);
    await click(tab, snap, (e) => e.tag === 'button' && e.label === '15', 'day 15');
    await sleep(300);
    const value = await page.evaluate(() => document.getElementById('tgl').value);
    check('P1 date picked by navigating the calendar widget', value === '2026-11-15', value);
  }

  // ---------- C1: canvas form (click_at + keyboard sequence) ----------
  {
    const page = await openPage('canvas-form.html');
    const tab = await tabIdFor('canvas-form');
    let snap = await observe(tab);
    const canvas = findEl(snap, byLabel('Form Canvas'), 'canvas');
    check('C1 canvas is observable as an element', canvas.tag === 'canvas', canvas.tag);
    await clickAt(tab, snap, byLabel('Form Canvas'), 'focus Nama field (coords)', 100, 55);
    await type(tab, snap, byLabel('Form Canvas'), 'type nama via keys', 'Budi');
    await clickAt(tab, snap, byLabel('Form Canvas'), 'focus Email field (coords)', 100, 135);
    await type(tab, snap, byLabel('Form Canvas'), 'type email via keys', 'budi@x.com');
    snap = await observe(tab);
    await click(tab, snap, byLabel('Simpan Canvas'), 'simpan');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('C1 canvas form filled via click_at + keyboard sequence',
      result === 'CANVAS OK nama=Budi email=budi@x.com', result);
  }

  // ---------- S1: full form inside shadow DOM ----------
  {
    const page = await openPage('shadow-form.html');
    await page.waitForFunction(() => document.querySelector('shadow-form')?.shadowRoot?.querySelector('input'));
    const tab = await tabIdFor('shadow-form');
    let snap = await observe(tab);
    await type(tab, snap, byLabel('Nama'), 'shadow nama', 'Fajar');
    await type(tab, snap, byLabel('Email'), 'shadow email', 'fajar@example.com');
    snap = await observe(tab);
    await click(tab, snap, byLabel('Kirim Shadow'), 'shadow submit');
    await sleep(300);
    const result = await page.evaluate(() => document.getElementById('result')?.textContent ?? '');
    check('S1 shadow DOM form filled + submitted', result === 'SHADOW OK nama=Fajar email=fajar@example.com', result);
  }
} finally {
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL FORM TESTS (BATCH 2) PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
