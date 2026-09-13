/**
 * Phase 0.6 Task 6 — THE ORDER. One market order, qty 1, into an armed replay
 * session, against seven predictions written down before the run.
 *
 * This is the first order this system has ever placed.
 *
 * SAFETY, in the order the checks run:
 *   1. the broker interlock is asserted immediately before the call, never cached
 *   2. the run REFUSES if any position, order or execution already exists, so
 *      "exactly one order" is enforced by the script rather than by my care
 *   3. exactly one placeOrder call, qty 1, market, no brackets
 *   4. the position is flattened before the script exits, and the flatten is
 *      verified rather than assumed
 *
 * Everything read is journalled, including the readings that disagree with the
 * predictions — especially those.
 */
import { writeFileSync } from 'node:fs';
import { evaluate } from '../src/connection.js';
import { assertReplayBrokerInterlock } from '../src/core/replay-interlock.js';
import { step } from '../src/core/replay.js';

const journal = { at: new Date().toISOString(), stages: [] };
const record = (stage, data) => {
  journal.stages.push({ stage, at: new Date().toISOString(), data });
  process.stderr.write(`[${stage}] ${JSON.stringify(data).slice(0, 400)}\n`);
  return data;
};

/** Everything the broker will tell us, in one round trip. */
const READ_JS = `
(async function () {
  function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
  async function safe(fn) { try { return await fn(); } catch (e) { return { __error: String(e && e.message || e) }; } }
  var req = null;
  window.webpackChunktradingview.push([[Math.random()], {}, function (r) { req = r; }]);
  var ts = req('822530').tradingService();
  var ab = ts.activeBroker();
  var acc = ab._brokerConnection._brokerConnection.currentAccountApi();
  var out = {};
  out.positions   = await safe(function () { return ab.positions(); });
  out.orders      = await safe(function () { return ab.orders(); });
  out.executions  = await safe(function () { return ab.executions ? ab.executions({ symbol: 'ICMARKETS:XAUUSD' }) : null; });
  out.equity      = await safe(function () { return acc.equityCapability.getEquity(); });
  out.report_data = await safe(function () { return acc.placeOrderCapability._transport.getActiveChartTradingData(); });
  out.market_price = await safe(function () { return acc.placeOrderCapability._transport.getMarketPrice('ICMARKETS:XAUUSD'); });
  out.replay_cursor = u(window.TradingViewApi._replayApi.currentDate());
  try {
    var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().mainSeries();
    var b = ms.bars(); var v = b.valueAt(b.lastIndex());
    out.last_bar = v ? { t: v[0], o: v[1], h: v[2], l: v[3], c: v[4] } : null;
  } catch (e) { out.last_bar_error = String(e && e.message || e); }
  return JSON.stringify(out);
})()`;

const read = async (label) => {
  const r = JSON.parse(await evaluate(READ_JS, { awaitPromise: true }));
  return record(label, r);
};

// ── 1. interlock, immediately before anything ──────────────────────────────
const interlock = await assertReplayBrokerInterlock();
record('interlock', interlock);

// ── 2. pre-state, and the refusal that keeps "exactly one" honest ──────────
const pre = await read('pre_order_state');
const nPos = Array.isArray(pre.positions) ? pre.positions.length : -1;
const nOrd = Array.isArray(pre.orders) ? pre.orders.length : -1;
if (nPos !== 0 || nOrd !== 0) {
  record('REFUSED', { why: 'the session is not flat', positions: pre.positions, orders: pre.orders });
  writeFileSync('recon/i08.json', JSON.stringify(journal, null, 2));
  console.error('REFUSING: session is not flat. Nothing was placed.');
  process.exit(1);
}

// ── 3. the order ───────────────────────────────────────────────────────────
// Built from the LIVE enums rather than hardcoded numbers, so a changed enum is
// a failure to construct rather than a wrong order.
const PLACE_JS = `
(async function () {
  var out = { ok: false };
  try {
    var req = null;
    window.webpackChunktradingview.push([[Math.random()], {}, function (r) { req = r; }]);
    var enums = req('601629');
    var ts = req('822530').tradingService();
    var ab = ts.activeBroker();
    var acc = ab._brokerConnection._brokerConnection.currentAccountApi();

    out.enums = { Side: enums.Side, OrderType: enums.OrderType };
    var order = {
      symbol: 'ICMARKETS:XAUUSD',
      side: enums.Side.Buy,
      type: enums.OrderType.Market,
      qty: 1,
    };
    out.order_sent = order;

    var t0 = Date.now();
    var ret = acc.placeOrderCapability.placeOrder(order);
    // P1 asks whether the generated id comes back SYNCHRONOUSLY. It matters:
    // a synchronous id makes intent-to-fill matching deterministic after the
    // fact, which is the most reconciliation can offer without a client id.
    out.returned_synchronously = !(ret && typeof ret.then === 'function');
    out.sync_value = out.returned_synchronously ? ret : null;
    var resolved = await ret;
    out.resolved = resolved;
    out.elapsed_ms = Date.now() - t0;
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message || e);
    out.stack = String(e && e.stack || '').slice(0, 600);
  }
  return JSON.stringify(out);
})()`;

const placed = record('place_order', JSON.parse(await evaluate(PLACE_JS, { awaitPromise: true })));
if (!placed.ok) {
  writeFileSync('recon/i08.json', JSON.stringify(journal, null, 2));
  console.error(`placeOrder threw: ${placed.error}`);
  console.error('NOTE: a rejected order IS the answer to the field-name question (P2). Nothing is open.');
  process.exit(1);
}

// ── 4. did it fill? ────────────────────────────────────────────────────────
let post = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  post = JSON.parse(await evaluate(READ_JS, { awaitPromise: true }));
  if (Array.isArray(post.positions) && post.positions.length > 0) break;
}
record('post_order_state', post);

// ── 5. P&L per point — the measurement P5 exists for ───────────────────────
// Step the replay cursor so price moves, then compare the position's P&L
// change against the price change. This is the only way to measure the
// denomination rather than infer it from quoted pip figures.
const pnlProbe = { samples: [] };
try {
  const sample = (label, s) => {
    const p = Array.isArray(s.positions) && s.positions[0] ? s.positions[0] : null;
    const row = {
      label,
      price: s.last_bar?.c ?? null,
      pl: p ? (p.pl ?? p.unrealizedPl ?? p.profit ?? null) : null,
      qty: p ? p.qty : null,
      avg_price: p ? (p.avgPrice ?? p.price ?? null) : null,
      equity: typeof s.equity === 'number' ? s.equity : null,
      cursor: s.replay_cursor,
    };
    pnlProbe.samples.push(row);
    return row;
  };
  sample('after_fill', post);
  for (let i = 0; i < 3; i++) {
    await step({ timeoutMs: 20000 });
    const s = JSON.parse(await evaluate(READ_JS, { awaitPromise: true }));
    sample(`after_step_${i + 1}`, s);
  }
  // Derive $ per point from the widest price move observed.
  const withBoth = pnlProbe.samples.filter((s) => s.price != null && s.pl != null);
  if (withBoth.length >= 2) {
    const a = withBoth[0];
    let best = null;
    for (const b of withBoth.slice(1)) {
      const dp = b.price - a.price;
      if (dp !== 0 && (best === null || Math.abs(dp) > Math.abs(best.dPrice))) {
        best = { dPrice: dp, dPl: b.pl - a.pl, from: a.label, to: b.label };
      }
    }
    if (best) {
      pnlProbe.dollars_per_point_at_qty1 = best.dPl / best.dPrice;
      pnlProbe.basis = best;
    } else {
      pnlProbe.note = 'price did not move across the sampled steps; $/point not derivable from this run';
    }
  }
} catch (err) {
  pnlProbe.error = err.message;
}
record('pnl_per_point', pnlProbe);

// ── 6. flatten, and verify it ──────────────────────────────────────────────
const FLATTEN_JS = `
(async function () {
  var out = { ok: false };
  try {
    var req = null;
    window.webpackChunktradingview.push([[Math.random()], {}, function (r) { req = r; }]);
    var ts = req('822530').tradingService();
    var ab = ts.activeBroker();
    var positions = await ab.positions();
    out.positions_before = positions;
    for (var i = 0; i < positions.length; i++) {
      await ab.closePosition(positions[i].id);
    }
    await new Promise(function (r) { setTimeout(r, 1500); });
    out.positions_after = await ab.positions();
    out.orders_after = await ab.orders();
    // CORRECTED after the live run: the Replay Broker does NOT remove a closed
    // position from positions(). It keeps the row with qty 0 (and avgPrice
    // null, side flipped), so "positions().length === 0" is never true once a
    // trade has existed, and the first run reported flattened:false for an
    // account that was genuinely flat. FLAT MEANS EVERY ROW HAS qty 0.
    out.flat = (out.positions_after || []).every(function (p) { return Number(p.qty) === 0; });
    out.open_qty = (out.positions_after || []).reduce(function (a, p) { return a + Math.abs(Number(p.qty) || 0); }, 0);
    out.ok = true;
  } catch (e) { out.error = String(e && e.message || e); }
  return JSON.stringify(out);
})()`;

const flat = record('flatten', JSON.parse(await evaluate(FLATTEN_JS, { awaitPromise: true })));
const final = await read('final_state');

journal.summary = {
  order_id: placed.resolved?.orderId ?? null,
  returned_synchronously: placed.returned_synchronously,
  filled: Array.isArray(post?.positions) && post.positions.length > 0,
  flattened: flat.flat === true,
  dollars_per_point_at_qty1: pnlProbe.dollars_per_point_at_qty1 ?? null,
  final_positions: Array.isArray(final.positions) ? final.positions.length : null,
};

writeFileSync('recon/i08.json', JSON.stringify(journal, null, 2));
console.log(JSON.stringify(journal.summary, null, 2));
process.exit(flat.flat === true ? 0 : 1);
