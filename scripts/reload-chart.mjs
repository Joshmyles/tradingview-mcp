#!/usr/bin/env node
/**
 * Reload the TradingView chart page and wait until it is genuinely usable again.
 *
 * "Usable" is not "the page load event fired". A seconds chart takes a long time
 * to come back, and every read in this harness is worthless until the main
 * series actually has bars, so the wait below polls for OBSERVED readiness and
 * fails loudly on timeout rather than returning early with a half-built chart.
 *
 * Run scripts/dump-chart-state.mjs and scripts/save-chart-layout.mjs FIRST.
 * This script refuses to run unless a verified dump exists on disk.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT } from '../src/connection.js';

const DUMP_DIR = join(process.cwd(), 'recon', 'chart-state');

// ---- Refuse without a verified backup. The ordering in the brief is the whole
//      point of the task; enforcing it here means it cannot be skipped by hand.
let dumps = [];
try {
  dumps = readdirSync(DUMP_DIR).filter((f) => /^drawings-.*\.json$/.test(f) && !f.includes('REJECTED'));
} catch {
  console.error(`REFUSING to reload: no dump directory at ${DUMP_DIR}. Run scripts/dump-chart-state.mjs first.`);
  process.exit(1);
}
if (dumps.length === 0) {
  console.error('REFUSING to reload: no verified drawing dump exists. Run scripts/dump-chart-state.mjs first.');
  process.exit(1);
}
const latest = dumps.sort().at(-1);
const dump = JSON.parse(readFileSync(join(DUMP_DIR, latest), 'utf8'));
if (!Array.isArray(dump.drawings) || dump.drawings.length === 0) {
  console.error(`REFUSING to reload: the latest dump (${latest}) contains no drawings.`);
  process.exit(1);
}
console.error(`Backup present: ${latest} (${dump.drawings.length} drawings).`);

// ---- Find the chart target directly; the pinned-connection helper caches an
//      execution context that the reload is about to destroy.
const targets = await CDP.List({ host: CDP_HOST, port: CDP_PORT });
const pages = targets.filter((t) => t.type === 'page' && /tradingview\.com\/chart/.test(t.url || ''));
if (pages.length !== 1) {
  console.error(`REFUSING to reload: expected exactly one chart page target, found ${pages.length}:`);
  for (const p of pages) console.error(`  ${p.id} ${p.url}`);
  process.exit(1);
}
const target = pages[0];
console.error(`Reloading target ${target.id} (${target.url})`);

const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
await client.Page.enable();
await client.Page.reload({ ignoreCache: false });

const READY_JS = `
(function () {
  function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
  try {
    if (!window.TradingViewApi) return JSON.stringify({ ready: false, why: 'no TradingViewApi' });
    var wv = window.TradingViewApi._activeChartWidgetWV;
    if (!wv) return JSON.stringify({ ready: false, why: 'no _activeChartWidgetWV' });
    var cw = wv.value();
    if (!cw) return JSON.stringify({ ready: false, why: 'chart widget not constructed' });
    var ms = cw._chartWidget.model().model().mainSeries();
    var n = ms.bars().size();
    return JSON.stringify({
      ready: n > 0,
      why: n > 0 ? 'bars present' : 'main series has no bars yet',
      bars: n,
      symbol: String(ms.symbol()),
      interval: String(ms.interval()),
    });
  } catch (e) {
    return JSON.stringify({ ready: false, why: String(e && e.message || e) });
  }
})()`;

const DEADLINE_MS = 180000;
const t0 = Date.now();
let last = null;
let ready = false;
while (Date.now() - t0 < DEADLINE_MS) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const res = await client.Runtime.evaluate({ expression: READY_JS, returnByValue: true });
    if (res.exceptionDetails) { last = { ready: false, why: 'evaluate threw' }; continue; }
    last = JSON.parse(res.result.value);
    if (last.ready) { ready = true; break; }
  } catch (err) {
    last = { ready: false, why: `CDP: ${err.message}` };
  }
}

await client.close();

const elapsed = Date.now() - t0;
if (!ready) {
  console.error(JSON.stringify({ ok: false, reloaded: true, ready: false, waited_ms: elapsed, last }, null, 2));
  console.error(`\nThe page reloaded but did not become usable within ${DEADLINE_MS}ms. Do NOT proceed.`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, reloaded: true, ready: true, waited_ms: elapsed, state: last }, null, 2));
process.exit(0);
