/**
 * Backtest recipes: run a window, run many windows.
 *
 * Two sources, one output shape:
 *
 *   - no `window`  → the on-chart strategy report, gated by the recompute
 *                    barrier (see settle.js)
 *   - a `window`   → a server-side Deep Backtest over exactly those dates
 *                    (see internals/deepbt.js)
 *
 * Both return the same normalised trades and the same aggregate block, so a
 * walk-forward row and an on-chart read are comparable without the caller
 * having to know which produced them. `source` on the response says which.
 *
 * The default payload is the aggregate, not the book. A 105-trade book is
 * ~77,000 characters; ten of them defeat the recipe they are supposed to
 * serve. Raw rows are opt-in via `include`.
 */
import { evaluate } from '../connection.js';
import { awaitSettled, SETTLE } from '../settle.js';
import { readStrategyReport } from '../strategy-report.js';
import {
  DEEPBT_HOOK_JS,
  DEEPBT_POLL_JS,
  DEEPBT_READ_JS,
  DEEPBT_RESTORE_JS,
  deepBtRequestJs,
  normaliseDeepOrder,
  normaliseDeepPerformance,
  normaliseDeepTrade,
} from '../internals/deepbt.js';
import {
  deepBtCompleted,
  deepBtWindowPlausible,
  isDeepBtErrored,
  isDeepBtRunning,
} from '../internals/readiness.js';
import { aggregateTrades } from '../internals/aggregate.js';
import { pineInputsAssert, resolveEntity } from './pine-inputs.js';
import { captureFence } from '../settle.js';

const DEFAULT_DEEP_TIMEOUT_MS = Number(process.env.TV_DEEPBT_TIMEOUT_MS) || 300000;
const POLL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one window server-side and return it normalised.
 *
 * Restores the Strategy Tester's live stream on every path out, including
 * failures: leaving it on the deep stream means the next on-chart read
 * describes a different window than the chart shows.
 */
export async function runDeepWindow({
  from,
  to,
  timeoutMs = DEFAULT_DEEP_TIMEOUT_MS,
  _deps,
} = {}) {
  const ev = _deps?.evaluate || evaluate;
  if (!Number.isFinite(Number(from)) || !Number.isFinite(Number(to))) {
    return { ok: false, reason: 'invalid_argument', error: 'from and to must be epoch milliseconds' };
  }
  if (Number(to) <= Number(from)) {
    return { ok: false, reason: 'invalid_argument', error: `to (${to}) must be after from (${from})` };
  }

  const hook = await ev(DEEPBT_HOOK_JS);
  if (!hook?.installed) {
    return {
      ok: false,
      reason: 'unavailable',
      error:
        hook?.reason ||
        'Deep Backtesting context not reachable. The Strategy Tester panel must be open.',
    };
  }
  // Without the edge counter there is no way to tell this run's report from the
  // cached previous one, and the failure is silent: the poll loop would run to
  // its full timeout and report that a finished run "never started". Refuse up
  // front instead.
  if (!hook.edges?.subscribed) {
    return {
      ok: false,
      reason: 'unavailable',
      error:
        'Could not subscribe to the deep-backtest status, so a completed run could not be ' +
        `distinguished from the cached previous one. ${hook.edges?.error || ''}`.trim(),
    };
  }

  const requested = { from: Number(from), to: Number(to) };
  let started;
  try {
    started = await ev(deepBtRequestJs(requested.from, requested.to));
  } finally {
    /* nothing to restore yet — the request itself sets the source */
  }
  if (!started?.ok) {
    await ev(DEEPBT_RESTORE_JS).catch(() => {});
    return { ok: false, reason: 'internal', error: started?.error || 'deep backtest request failed' };
  }
  const since = started.edges_before || { running: 0, done: 0 };

  const t0 = Date.now();
  let last = null;
  try {
    for (;;) {
      await sleep(POLL_MS);
      last = await ev(DEEPBT_POLL_JS);
      if (isDeepBtErrored(last)) {
        return {
          ok: false,
          reason: 'errored',
          error: 'Deep backtest reported an error status.',
          poll: last,
        };
      }
      if (deepBtCompleted(last, since)) break;
      if (Date.now() - t0 > timeoutMs) {
        return {
          ok: false,
          reason: 'timed_out',
          error:
            `Deep backtest did not complete within ${timeoutMs}ms. ` +
            (isDeepBtRunning(last) ? 'It is still running; raise TV_DEEPBT_TIMEOUT_MS.' : 'It never started.'),
          poll: last,
        };
      }
    }

    const raw = await ev(DEEPBT_READ_JS);
    if (!raw?.ok) {
      return { ok: false, reason: 'internal', error: raw?.error || 'deep report unreadable' };
    }

    const actual = raw.window?.backtest ?? null;
    if (!deepBtWindowPlausible(actual, requested)) {
      return {
        ok: false,
        reason: 'window_mismatch',
        error:
          'The deep report describes a window that does not overlap the one requested. ' +
          'The cached report from a previous run is the usual cause.',
        requested,
        actual,
      };
    }

    const trades = (raw.trades || []).map(normaliseDeepTrade);
    return {
      ok: true,
      source: 'deep_backtest',
      requested,
      // TradingView snaps a requested window to available data. This is the
      // window the numbers actually describe; report it, never the request.
      window: {
        backtest_from: actual?.from ?? null,
        backtest_to: actual?.to ?? null,
        trade_from: raw.window?.trade?.from ?? null,
        trade_to: raw.window?.trade?.to ?? null,
        snapped:
          actual?.from !== requested.from || actual?.to !== requested.to,
      },
      elapsed_ms: Date.now() - t0,
      performance: normaliseDeepPerformance(raw.performance, raw),
      trades,
      orders: (raw.filled_orders || []).map(normaliseDeepOrder),
      equity_present: raw.equity_present === true,
    };
  } finally {
    await ev(DEEPBT_RESTORE_JS).catch(() => {});
  }
}

/** Read the on-chart report through the barrier, in the same output shape. */
async function runOnChart({ entityId, timeoutMs, fence = null }) {
  const settled = await awaitSettled({ entityId, scope: entityId ? 'target' : 'strategies', timeoutMs });
  if (settled.outcome !== SETTLE.SETTLED) {
    return { ok: false, reason: settled.outcome, error: settled.error, settle: settled };
  }
  const r = await readStrategyReport({ entityId, fence, timeoutMs });
  if (!r.ok) return r;
  return {
    ok: true,
    source: 'on_chart',
    window: r.window,
    performance: r.performance,
    trades: r.trades,
    orders: r.orders || [],
    reconciliation: r.reconciliation,
    entity_id: r.entity_id,
    inputs_hash: r.inputs_hash,
  };
}

/**
 * One backtest, aggregated.
 *
 * @param {object}   opts
 * @param {string}   [opts.entityId]     study to read; on-chart path only
 * @param {object}   [opts.window]       { from, to } epoch ms → deep backtest
 * @param {string[]} [opts.include]      'trades' | 'orders' to add raw rows
 * @param {number[]} [opts.stopLevels]   candidate stop levels for the counterfactual
 * @param {string[]} [opts.splitTokens]  entry-tag tokens to split the book on
 */
export async function backtestRun({
  entityId = null,
  window = null,
  include = [],
  stopLevels = null,
  splitTokens = ['ADD'],
  manifest = null,
  build = null,
  timeoutMs = DEFAULT_DEEP_TIMEOUT_MS,
  _deps,
} = {}) {
  // Resolve the study explicitly, and refuse if the chart carries more than
  // one candidate. A deep run reads whichever strategy the Strategy Tester has
  // selected, so with B14 and B15 both loaded "the backtest" is not a
  // well-formed request — and the result would carry no evidence of which one
  // it described.
  const target = await (_deps?.resolveOne || resolveEntity)({ hint: entityId, _deps });
  if (!target.ok) {
    return {
      ok: false,
      success: false,
      reason: target.reason === 'ambiguous' ? 'ambiguous_entity' : target.reason,
      error: target.error,
      candidates: target.candidates,
    };
  }
  const resolved = target.resolved;

  // Assert the configuration BEFORE running, not after. A run that has already
  // happened against the wrong inputs has cost the time either way, but a
  // result returned alongside a warning gets quoted without the warning.
  let asserted = null;
  if (manifest) {
    asserted = await (_deps?.pineInputsAssert || pineInputsAssert)({
      manifest, build, entityId: resolved.entity_id, _deps,
    });
    if (!asserted.ok) {
      return {
        ...asserted,
        ok: false,
        reason: asserted.reason || 'inputs_mismatch',
        error:
          (asserted.error || 'The chart is not carrying the asserted configuration.') +
          ' No backtest was run, because its result would not describe the configuration you asked for.',
      };
    }
  }

  // A drift baseline, not a demand for a rebuild: nothing here mutates. It
  // carries the resolved entity, so a report read from another study is
  // refused rather than silently skipping every per-strategy check.
  const fence = window ? null : await (_deps?.captureFence || captureFence)({ entityId: resolved.entity_id });

  const base = window
    ? await runDeepWindow({ from: window.from, to: window.to, timeoutMs, _deps })
    : await runOnChart({ entityId: resolved.entity_id, fence, timeoutMs });
  if (!base.ok) return base;

  const out = {
    ok: true,
    success: true,
    source: base.source,
    entity_id: base.entity_id ?? resolved.entity_id,
    entity_title: resolved.title ?? null,
    build: resolved.build ?? null,
    window: base.window,
    requested_window: base.requested ?? null,
    performance: base.performance,
    trade_count: base.trades.length,
    order_count: base.orders.length,
    aggregate: aggregateTrades(base.trades, { splitTokens, stopLevels }),
  };
  if (asserted) {
    out.inputs_asserted = {
      manifest_hash: asserted.manifest_hash,
      ...(asserted.asserted_build && { build: asserted.asserted_build }),
      checked: asserted.checked,
      matched: asserted.matched,
      not_in_manifest_count: asserted.not_in_manifest_count,
    };
  }
  if (base.reconciliation) out.reconciliation = base.reconciliation;
  if (base.elapsed_ms != null) out.elapsed_ms = base.elapsed_ms;
  if (base.inputs_hash) out.inputs_hash = base.inputs_hash;
  if (base.equity_present === false) {
    out.equity_note =
      'No per-bar equity curve in this report. Sharpe and max drawdown here are ' +
      "TradingView's own, computed by a method this bridge cannot inspect. See PROVENANCE 'Known gaps'.";
  }
  if (include.includes('trades')) out.trades = base.trades;
  if (include.includes('orders')) out.orders = base.orders;
  return out;
}

/**
 * The same run over many windows, one aggregated row each.
 *
 * Sequential by necessity — there is one Strategy Tester and one deep stream,
 * and two overlapping requests would race for the same cached report slot.
 * A failed window does not stop the walk; it is reported in place, because a
 * walk-forward with a hole in it is still evidence and a walk-forward that
 * aborted at window three is not.
 */
export async function walkForward({
  windows = [],
  entityId = null,
  stopLevels = null,
  splitTokens = ['ADD'],
  manifest = null,
  build = null,
  timeoutMs = DEFAULT_DEEP_TIMEOUT_MS,
  _deps,
} = {}) {
  if (!Array.isArray(windows) || !windows.length) {
    return { ok: false, reason: 'invalid_argument', error: 'windows must be a non-empty array of { from, to }' };
  }
  const rows = [];
  for (const w of windows) {
    const r = await backtestRun({
      entityId, window: w, stopLevels, splitTokens, manifest, build, timeoutMs, _deps,
    });
    rows.push(
      r.ok
        ? {
            ok: true,
            requested: r.requested_window,
            window: r.window,
            trades: r.trade_count,
            performance: r.performance,
            aggregate: r.aggregate,
            elapsed_ms: r.elapsed_ms,
          }
        : { ok: false, requested: w, reason: r.reason, error: r.error },
    );
  }
  const good = rows.filter((r) => r.ok);
  const ind = independence(good);
  return {
    ok: true,
    success: true,
    windows_requested: windows.length,
    windows_completed: good.length,
    windows_failed: rows.length - good.length,
    ...ind.summary,
    rows,
    // Pooled across DISTINCT snapped windows, so a level or a distribution is
    // not read off one window — and not read twice off the same one. See
    // independence() for why the deduplication is not optional.
    pooled: ind.distinct.length
      ? {
          windows: ind.distinct.length,
          trades: ind.distinct.reduce((s, r) => s + r.trades, 0),
          net: round2(ind.distinct.reduce((s, r) => s + (r.performance?.net_profit ?? 0), 0)),
          per_window_net: ind.distinct.map((r) => round2(r.performance?.net_profit ?? 0)),
        }
      : null,
  };
}

/**
 * Are these rows independent observations, or the same window counted twice?
 *
 * TradingView SNAPS a requested backtest range to the data it has. Measured:
 * `1787695320000..1788300000000` came back as `1787616030000..1788220785000`,
 * and two different requests snapped to the SAME window. A walk-forward whose
 * rows are pooled as independent when two of them describe identical data
 * overstates its sample and understates its variance — and nothing in the
 * output would say so, because each row looks like a complete, distinct
 * result.
 *
 * So: pool over distinct snapped windows, and report duplicates and overlaps
 * rather than averaging them away. Overlap is flagged and not deduplicated —
 * partial overlap is a matter of degree and the caller has to judge it — but
 * an exact repeat is not evidence of anything and is dropped from the pool.
 */
export function independence(rows) {
  const seen = new Map();
  const distinct = [];
  const duplicates = [];
  rows.forEach((r, i) => {
    const key = `${r.window?.backtest_from}|${r.window?.backtest_to}`;
    if (seen.has(key)) {
      duplicates.push({
        window: { from: r.window?.backtest_from ?? null, to: r.window?.backtest_to ?? null },
        rows: [seen.get(key), i],
        requested: [rows[seen.get(key)].requested, r.requested],
      });
      return;
    }
    seen.set(key, i);
    distinct.push(r);
  });

  const overlaps = [];
  for (let a = 0; a < distinct.length; a++) {
    for (let b = a + 1; b < distinct.length; b++) {
      const A = distinct[a].window, B = distinct[b].window;
      if (A?.backtest_from == null || B?.backtest_from == null) continue;
      const lo = Math.max(A.backtest_from, B.backtest_from);
      const hi = Math.min(A.backtest_to, B.backtest_to);
      if (hi > lo) overlaps.push({ rows: [a, b], overlap_ms: hi - lo });
    }
  }

  const warnings = [];
  if (duplicates.length) {
    warnings.push(
      `${duplicates.length} requested window(s) snapped onto a window already covered. They are excluded from "pooled": ` +
        'two rows describing the same data are one observation, not two. Per-row results are kept so the collision is visible.',
    );
  }
  if (overlaps.length) {
    warnings.push(
      `${overlaps.length} pair(s) of distinct windows OVERLAP after snapping, so the rows are not independent. ` +
        'They are still pooled — partial overlap is a judgement call — but do not treat the window count as a sample size.',
    );
  }
  return {
    distinct,
    summary: {
      windows_distinct: distinct.length,
      windows_duplicated: duplicates.length,
      ...(duplicates.length && { duplicate_windows: duplicates }),
      ...(overlaps.length && { overlapping_windows: overlaps }),
      ...(warnings.length && { independence_warning: warnings.join(' ') }),
    },
  };
}

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
