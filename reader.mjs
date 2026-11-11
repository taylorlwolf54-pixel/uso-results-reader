// Reads the public UKI results page (results.gacsystems.com) the way a visitor's browser does,
// picks out results for dogs in the tracker's entries, and posts them to the tracker.
//
// The results site is a Flutter app that draws on a canvas, so the reader switches on the app's
// built-in accessibility mode (the same text a screen reader gets) and reads that.
//
// Settings (environment variables):
//   SPACEFAST_API_KEY Spacefast key allowed to publish the tracker Space (required unless DRY_RUN=1)
//   SPACE_ID          default spc_b68be652bf7e4d02a7cd7fcff39eb3bd (bright-harbor)
//   TRACKER_URL       default https://bright-harbor.space.fast
//   RESULTS_URL       default https://results.gacsystems.com/
//   EVENT_MATCH       text that identifies the event on the results home screen, default "US Open"
//   POLL_SECONDS      pause between passes, default 90
//   RUN_MINUTES       how long to keep polling before exiting, default 55 (0 = one pass)
//   SNAPSHOT_DIR      when set, saves each screen's text and a screenshot there (for tuning)
//   DRY_RUN=1         read and print, but don't post
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildIndex, matchClass, matchDate, recordsFromScreen, fold } from './match.mjs';
import { merge, publishResults } from './publish.mjs';

const env = process.env;
const TRACKER = (env.TRACKER_URL || 'https://bright-harbor.space.fast').replace(/\/$/, '');
const RESULTS_URL = env.RESULTS_URL || 'https://results.gacsystems.com/';
const EVENT_MATCH = new RegExp(env.EVENT_MATCH || 'US Open', 'i');
const POLL = Math.max(45, Number(env.POLL_SECONDS || 90)) * 1000;
const RUN_MS = Number(env.RUN_MINUTES ?? 55) * 60000;
const SNAP = env.SNAPSHOT_DIR || '';
const DRY = env.DRY_RUN === '1';
const SPACE_ID = env.SPACE_ID || 'spc_b68be652bf7e4d02a7cd7fcff39eb3bd';
const PAUSE = 1500; // between clicks, to stay gentle on their site

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadEntries() {
  const r = await fetch(TRACKER + '/entries.json?_=' + Date.now());
  if (!r.ok) throw Error('entries.json HTTP ' + r.status);
  const d = await r.json();
  if (d.schemaVersion !== 3) throw Error('Unexpected entries schema');
  return buildIndex(d);
}

// ---------- reading the Flutter screen ----------
async function enableSemantics(page) {
  await page.waitForSelector('flt-glass-pane, flutter-view, flt-semantics-placeholder', { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => {
    const p = document.querySelector('flt-semantics-placeholder');
    if (p) p.click();
  });
  await page.waitForSelector('flt-semantics', { timeout: 15000 }).catch(() => {});
  await sleep(1500);
}

// Every piece of text on screen with its position; tappable items flagged.
async function readItems(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('flt-semantics, [role="button"], [role="link"], [role="tab"], [role="row"], [role="cell"]')) {
      const label = (el.getAttribute('aria-label') || '').trim();
      // Text that belongs to this node only (children report their own).
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      for (const n of el.children) if (!/^FLT-SEMANTICS/i.test(n.tagName) && !n.querySelector('flt-semantics')) own += ' ' + n.textContent;
      const text = (label || own).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const role = el.getAttribute('role') || '';
      const tappable = /button|link|tab|menuitem/.test(role) || el.hasAttribute('flt-tappable') || el.style.cursor === 'pointer';
      out.push({ text, x: r.x, y: r.y, w: r.width, h: r.height, tappable });
    }
    return out;
  });
}

// Group items into visual rows (same height on screen), left to right.
function toLines(items) {
  const sorted = [...items].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const cy = it.y + it.h / 2;
    const line = lines.find(l => Math.abs(l.cy - cy) <= 8);
    if (line) line.items.push(it); else lines.push({ cy, items: [it] });
  }
  return lines.map(l => {
    const parts = [];
    for (const it of l.items.sort((a, b) => a.x - b.x)) if (!parts.includes(it.text)) parts.push(it.text);
    // A row container often carries the whole row as one label; keep the longest version.
    const joined = parts.join(' | ');
    return { text: joined, y: l.cy };
  });
}

// Read a whole screen, scrolling to reveal rows a long list hides.
async function readScreen(page) {
  const seen = new Map();
  for (let i = 0; i < 40; i++) {
    const lines = toLines(await readItems(page));
    let added = 0;
    for (const l of lines) if (!seen.has(l.text)) { seen.set(l.text, seen.size); added++; }
    if (i > 0 && !added) break;
    await page.mouse.move(640, 700);
    await page.mouse.wheel(0, 2500);
    await sleep(700);
  }
  return [...seen.keys()];
}

async function snapshot(page, name, lines) {
  if (!SNAP) return;
  await fs.mkdir(SNAP, { recursive: true });
  const base = path.join(SNAP, name.replace(/[^a-z0-9]+/gi, '-').slice(0, 80));
  await fs.writeFile(base + '.txt', page.url() + '\n\n' + lines.join('\n'));
  await page.screenshot({ path: base + '.png', fullPage: false }).catch(() => {});
}

async function clickText(page, text) {
  const items = await readItems(page);
  const it = items.find(i => i.text === text && i.tappable) || items.find(i => i.text === text);
  if (!it) return false;
  await page.mouse.click(it.x + Math.min(it.w / 2, 200), it.y + it.h / 2);
  await sleep(PAUSE);
  return true;
}

async function goBack(page, homeUrl) {
  const before = page.url();
  await page.goBack({ timeout: 10000 }).catch(() => {});
  await sleep(PAUSE);
  if (page.url() !== before) return;
  const items = await readItems(page);
  const back = items.find(i => /^(back|close)$/i.test(i.text));
  if (back) { await page.mouse.click(back.x + back.w / 2, back.y + back.h / 2); await sleep(PAUSE); return; }
  await page.goto(homeUrl); await enableSemantics(page);
}

// ---------- one full pass ----------
async function pass(browser, index) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 3000 } });
  const records = [];
  const screens = [];
  try {
    await page.goto(RESULTS_URL, { waitUntil: 'load', timeout: 60000 });
    await enableSemantics(page);
    await sleep(3000); // live data arrives after first paint
    let home = await readScreen(page);
    await snapshot(page, '00-home', home);
    if (home.some(l => /no public events/i.test(l))) return { records, note: 'No public events listed yet' };

    // Open the event (skip if the site lands straight on it).
    const eventLine = home.find(l => EVENT_MATCH.test(l));
    let eventUrl = page.url();
    if (eventLine) {
      const items = await readItems(page);
      const it = items.find(i => EVENT_MATCH.test(i.text) && i.tappable) || items.find(i => EVENT_MATCH.test(i.text));
      if (it) { await page.mouse.click(it.x + Math.min(it.w / 2, 200), it.y + it.h / 2); await sleep(PAUSE * 2); }
      eventUrl = page.url();
    }
    const eventLines = await readScreen(page);
    await snapshot(page, '01-event', eventLines);
    screens.push({ heading: eventLines.slice(0, 6).join(' '), lines: eventLines, sourceUrl: eventUrl });

    // Each tappable item that names one of the tracker's classes is a class to open.
    const targets = [];
    for (const it of await readItems(page)) {
      if (!it.tappable) continue;
      const cls = matchClass(it.text, index);
      if (cls && !targets.some(t => t.text === it.text)) targets.push({ text: it.text, cls });
    }
    log(`Event screen: ${eventLines.length} lines, ${targets.length} class links`);
    for (const [n, t] of targets.entries()) {
      if (!await clickText(page, t.text)) continue;
      await sleep(PAUSE);
      const lines = await readScreen(page);
      await snapshot(page, `02-${String(n).padStart(2, '0')}-${t.text}`, lines);
      // Heading = the link we tapped plus the top of the screen (class, ring, day are usually there).
      screens.push({ heading: t.text + ' ' + lines.slice(0, 6).join(' '), lines, sourceUrl: page.url() });
      await goBack(page, eventUrl);
    }
  } finally {
    await page.close();
  }
  for (const s of screens) records.push(...recordsFromScreen(s, index));
  return { records, note: `${screens.length} screens read` };
}

// Same run result seen on several screens: keep one.
function dedupe(records) {
  const m = new Map();
  for (const r of records) m.set(JSON.stringify([r.handler, r.dog, r.class, r.date || '', r.height || '']), r);
  return [...m.values()];
}

async function post(records, index) {
  const live = await fetch(TRACKER + '/results.json?_=' + Date.now()).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!live) throw Error('Could not read the live results.json; not publishing');
  const allowed = new Set(index.entrants.map(e => e.key));
  const { changed, data } = merge(live, records, allowed);
  if (!changed) { log('No new or changed results'); return; }
  if (DRY) { log(`DRY RUN — would publish ${data.results.length} results (${changed} new/changed)`); console.log(JSON.stringify(data.results.slice(-10), null, 1)); return; }
  const v = await publishResults(data, { spaceId: SPACE_ID, key: env.SPACEFAST_API_KEY });
  log(`Published results.json as version v${v.number}: ${data.results.length} results, ${changed} new/changed`);
}

async function main() {
  if (!DRY && !env.SPACEFAST_API_KEY) throw Error('SPACEFAST_API_KEY is not set');
  const stopAt = Date.now() + RUN_MS;
  const browser = await chromium.launch({ channel: env.BROWSER_CHANNEL || undefined });
  let index = await loadEntries(), indexAt = Date.now(), last = '', failures = 0;
  try {
    do {
      const started = Date.now();
      try {
        if (Date.now() - indexAt > 30 * 60000) { index = await loadEntries(); indexAt = Date.now(); }
        const { records, note } = await pass(browser, index);
        const found = dedupe(records);
        log(`${note}; ${found.length} results for entered dogs`);
        const sig = JSON.stringify(found.map(({ verifiedAt, ...r }) => r));
        if (found.length && sig !== last) { await post(found, index); last = sig; }
        failures = 0;
      } catch (e) {
        failures++;
        log('Pass failed:', e.message);
        if (failures >= 5) throw e;
      }
      if (Date.now() + POLL > stopAt) break;
      await sleep(Math.max(5000, POLL - (Date.now() - started)));
    } while (RUN_MS > 0);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
