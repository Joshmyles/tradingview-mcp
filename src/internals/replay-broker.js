/**
 * Replay Broker READS, and the three traps that were measured on them.
 *
 * INTERNAL. Nothing here submits, modifies or cancels anything: every page
 * expression below is a read. Order emission belongs to the replay profile,
 * behind the broker interlock (core/replay-interlock.js).
 *
 * Each trap below has a wrong-looking-correct alternative, which is why each is
 * a named helper with a test (tests/replay-broker-refutations.test.js) rather
 * than a comment at a call site. Measured on one live fill, 2026-09-12,
 * recon/i08.json, order_2481ed79-1dc0-4828-9e3d-dc5bb0ec82c8.
 *
 * ── 1. THE FILL SURFACE IS allExecutions(), NOT executions({symbol}) ─────────
 *
 * `activeBroker().executions({ symbol })` returned [] after a confirmed fill and
 * stayed empty through the close. `allExecutions()` returned both fills in full.
 * A reconciliation loop reading the filtered call sees no fills and concludes
 * nothing happened: a silent success arriving from the API rather than from our
 * code. Fills are therefore read unfiltered and filtered HERE, client-side.
 *
 * ── 2. getEquity() IS REALISED P&L PLUS COMMISSION ONLY ─────────────────────
 *
 * It moved 100000 -> 99999.89 at entry (the 0.11 commission) and then did NOT
 * move while the position's unrealised P&L ran -2.51 -> -3.59 -> -1.00. It
 * moved again only on the close. Any risk, drawdown or MAE logic that reads it
 * sees a flat line through an open loss. The field is therefore returned as
 * `realised_equity`, never `equity`, and mark-to-market is a separate, explicit
 * computation that adds the positions' unrealised P&L.
 *
 * ── 3. A CLOSED POSITION KEEPS ITS ROW ──────────────────────────────────────
 *
 * After the close, positions() still held the row with qty 0, avgPrice null and
 * the side FLIPPED (1 -> -1). `positions().length === 0` is never true once a
 * trade has existed, so a flatten-and-verify loop testing it hangs forever on a
 * genuinely flat account, and the side of a zero row means nothing.
 * Flat means every row has qty === 0.
 *
 * ── ORDER IDS ───────────────────────────────────────────────────────────────
 *
 * placeOrder() is a promise resolving `{ orderId: "order_<guid>", result: 0 }`
 * (701ms observed). The id is generated inside the call and does not exist
 * until the promise resolves, so it can never serve as a pre-submit key: an
 * intent whose response is lost has no id to look up. It is a matching handle
 * after the fact only. Idempotency stays single-flight plus a pre-submit
 * orders()/allExecutions() snapshot and a re-read on any ambiguous response.
 */

/** Rows from positions(). Throws on anything that is not an array. */
function assertRows(positions, fn) {
  if (!Array.isArray(positions)) {
    throw new TypeError(
      `${fn}(): positions must be the array positions() returned, got ${positions === null ? 'null' : typeof positions}. `
      + 'Refusing to call an unreadable position list flat.',
    );
  }
}

/**
 * Trap 3. Flat means every row has qty 0 — an empty list is only the
 * never-traded case, and a zero row's side is not meaningful.
 */
export function isFlat(positions) {
  assertRows(positions, 'isFlat');
  return positions.every((p) => Number(p?.qty) === 0);
}

/** Absolute open quantity across rows. A zero row contributes nothing whatever its side. */
export function openQty(positions) {
  assertRows(positions, 'openQty');
  return positions.reduce((a, p) => a + Math.abs(Number(p?.qty) || 0), 0);
}

/**
 * Trap 1. Fills for one symbol, filtered client-side from allExecutions().
 *
 * Takes the UNFILTERED list on purpose: there is no parameter for passing the
 * broker's own filtered result, because that result was measured empty.
 */
export function fillsFor(allExecutions, { symbol } = {}) {
  if (!Array.isArray(allExecutions)) {
    throw new TypeError('fillsFor(): pass the array allExecutions() returned.');
  }
  return symbol ? allExecutions.filter((x) => x?.symbol === symbol) : allExecutions.slice();
}

/**
 * Trap 2. Mark-to-market equity = realised equity + open unrealised P&L.
 *
 * `realisedEquity` MUST be the getEquity() reading. The name is the guard: a
 * caller holding a number called `equity` has already lost the distinction.
 * Throws if an open position carries no readable unrealised P&L, because
 * silently treating it as zero reproduces exactly the flat line this exists for.
 */
export function markToMarket({ realisedEquity, positions }) {
  if (typeof realisedEquity !== 'number' || !Number.isFinite(realisedEquity)) {
    throw new TypeError('markToMarket(): realisedEquity must be the finite getEquity() reading.');
  }
  assertRows(positions, 'markToMarket');
  let unrealised = 0;
  for (const p of positions) {
    if (Number(p?.qty) === 0) continue;
    const u = Number(p?.unrealizedPl);
    if (!Number.isFinite(u)) {
      throw new Error(
        `markToMarket(): open position ${p?.id ?? '?'} (qty ${p?.qty}) has no readable unrealizedPl. `
        + 'Refusing to value it at zero: getEquity() excludes unrealised P&L, so a missing figure is an unknown loss, not a flat one.',
      );
    }
    unrealised += u;
  }
  return { realised_equity: realisedEquity, unrealised_pl: unrealised, mark_to_market: realisedEquity + unrealised };
}

/**
 * Page-context JS: one round trip of every broker read, named so the traps are
 * visible in the payload.
 *
 * `executions_symbol_filtered` is read ONLY so the refutation can be pinned
 * live (tests/live/replay-broker-surfaces.test.js); nothing may consume it.
 */
export function brokerReadJs(symbol) {
  return `
(async function () {
  var req = null;
  window.webpackChunktradingview.push([[Math.random()], {}, function (r) { req = r; }]);
  async function safe(fn) { try { return await fn(); } catch (e) { return { __error: String(e && e.message || e) }; } }
  var ab = req('822530').tradingService().activeBroker();
  var out = { read_at: Date.now(), broker_present: !!ab };
  if (!ab) return JSON.stringify(out);
  var acc = null;
  try { acc = ab._brokerConnection._brokerConnection.currentAccountApi(); } catch (e) {}
  out.positions = await safe(function () { return ab.positions(); });
  out.orders = await safe(function () { return ab.orders(); });
  // THE fill surface (trap 1).
  out.all_executions = await safe(function () { return ab.allExecutions(); });
  // Pinned refutation only. Measured [] after a confirmed fill. Do not consume.
  out.executions_symbol_filtered = await safe(function () { return ab.executions({ symbol: ${JSON.stringify(symbol)} }); });
  // REALISED P&L + commission only (trap 2). Never read this as account value.
  out.realised_equity = acc ? await safe(function () { return acc.equityCapability.getEquity(); }) : null;
  return JSON.stringify(out);
})()`;
}
