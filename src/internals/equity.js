/**
 * Per-bar mark-to-market equity reconstruction.
 *
 * WHY THIS EXISTS
 * ---------------
 * `reportData` carries no per-bar account curve. It carries `trades[].cp.v`,
 * a cumulative P&L indexed by CLOSED TRADE, and `performance.sharpeRatio` /
 * `sortinoRatio` / `maxStrategyDrawDown`, computed by TradingView from a curve
 * it does not expose. The acceptance bar for this programme includes
 * Sharpe >= 2.3, so that criterion currently rests on an uninspectable number.
 *
 * This module computes the curve from data that IS exposed - the trade legs
 * and the price bars - by a method written down here, reproducible across
 * builds, and applicable unchanged to live fills when the execution service
 * exists.
 *
 * WHAT IS RECONSTRUCTED, AND FROM WHAT
 * ------------------------------------
 * Position state per bar comes from the trade rows, not from `filledOrders`.
 * Both describe the same fills, but a trade row carries an epoch-millisecond
 * timestamp on each side while a filled order carries `tm` = a bar SEQUENCE
 * NUMBER (see internals/README.md). Reconstruction has to join fills to bars,
 * and a join needs a time. Multi-quantity closes are already split into one
 * row per leg by TradingView, so the rows are a complete leg-level ledger:
 * summing signed leg quantity over rows reproduces net position exactly.
 *
 * THE INDEX-SPACE TRAP (measured 2026-09-10)
 * ------------------------------------------
 * `trades[].e.b` / `.x.b` are indices in the STUDY's bar space, which counts
 * from the first bar of loaded history. `bars().firstIndex()` is negative and
 * rebases on whatever is currently loaded. Measured on the live 45S chart:
 * the book spanned study bars 156..21673 while the price series held bars
 * -66..305 - 372 bars, disjoint index ranges, same chart, same instant.
 * A reconstruction that joins on bar index silently reads the wrong bars.
 *
 * ALWAYS JOIN BY TIME. The index offset is derived afterwards and asserted, as
 * a check on the join, never used to perform it.
 *
 * DEFINITIONS (all of them, because a ratio without its definition is a rumour)
 * ---------------------------------------------------------------------------
 * equity[b]      = realised[b] + unrealised[b]
 * realised[b]    = sum of net_profit over legs whose exit bar <= b. Net of
 *                  commission, because `tp.v` is.
 * unrealised[b]  = netQty[b] * close[b] - costBasis[b], where a leg opening at
 *                  bar e adds (dir*qty) to netQty and (dir*qty*entryPrice) to
 *                  costBasis, and removes both at its exit bar. This is GROSS
 *                  of the commission that will be charged when the leg closes,
 *                  so equity steps down by the leg's commission at exit. The
 *                  bias is bounded by open commission and is reported as
 *                  `unrealised_excludes_commission`.
 * delta[b]       = equity[b] - equity[b-1], in account currency.
 *
 * Sharpe and Sortino are computed on delta - per-bar DOLLAR increments - not
 * on percentage returns of an account balance. Two reasons. The report exposes
 * no initial capital (settings carries `dateRange` and nothing else), so any
 * percentage base would be invented. And at fixed contract size the two differ
 * only by that constant, which cancels in the ratio. Risk-free rate is zero.
 *
 *   sharpe  = mean(delta) / sd(delta) * sqrt(periodsPerYear)     sd is n-1
 *   sortino = mean(delta) / sqrt(mean(min(0, delta)^2)) * sqrt(periodsPerYear)
 *
 * The Sortino denominator averages the squared downside over ALL periods, not
 * only the losing ones. Both conventions are in use and they differ by a
 * factor of sqrt(n/n_down); this one is stated so a future comparison is not
 * made against a differently-defined number.
 *
 * periodsPerYear is derived from the bars actually present, not from the
 * nominal bar length: barsObserved / (spanSeconds / SECONDS_PER_YEAR). Gold is
 * closed at weekends, so a nominal 45-second period implies 700,800 bars a
 * year and overstates the annualisation by roughly the fraction of the week
 * the market is shut.
 *
 * WHAT MUST NOT BE COMPARED
 * -------------------------
 * TradingView's `maxStrategyDrawDown` comes from its own curve by its own
 * method. `normaliseEquity`'s `per_closed_trade` curve must never be compared
 * against it - that rule predates this module and still holds. The curve here
 * IS per-bar and so is comparable in KIND, but not in method: a difference is
 * evidence about the two methods, never a defect in this one. Report both,
 * subtract neither.
 */

import { describe as describeStat } from './aggregate.js';

/** Julian year in seconds - the annualisation constant, named so it is not a magic number. */
const SECONDS_PER_YEAR = 31557600;

const r = (v, dp = 6) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Locate the bar covering an instant.
 *
 * Bar time is the bar's OPEN time, so the covering bar is the last one whose
 * time is <= t. Returns -1 when t precedes the first loaded bar, which is the
 * signal that history does not reach far enough - never clamp it to 0, or a
 * trade outside the loaded range silently marks against the wrong bar.
 */
export function barIndexAt(times, t) {
  if (!times.length || t < times[0]) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Normalise the raw bar tuples into parallel arrays.
 *
 * Input is `[time, open, high, low, close, volume]` with time in SECONDS, the
 * shape `bars().valueAt(i)` returns. Trade timestamps are in MILLISECONDS.
 * The two units are converted at exactly one place - here - so the mismatch
 * cannot be reintroduced by a caller.
 */
export function prepareBars(raw) {
  const n = raw.length;
  const times = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = raw[i];
    times[i] = b[0] * 1000;
    high[i] = b[2];
    low[i] = b[3];
    close[i] = b[4];
  }
  return { n, times, high, low, close };
}

/**
 * Reconstruct the per-bar equity curve.
 *
 * Open rows are excluded: their exit is a synthesised mark-to-market whose
 * price moves on every tick (see report.js/markOpenTrades). Including one
 * would put a moving number into a curve that is supposed to be reproducible.
 */
export function reconstructEquity(trades, bars) {
  const { n, times, close } = bars;
  const dQty = new Float64Array(n + 1);
  const dBasis = new Float64Array(n + 1);
  const dRealised = new Float64Array(n + 1);

  const placed = [];
  const unplaced = [];
  let openExcluded = 0;
  let commissionSeen = 0;

  for (const t of trades) {
    if (t.is_open || t.exit == null || t.entry?.time == null || t.exit?.time == null) {
      openExcluded++;
      continue;
    }
    const ei = barIndexAt(times, t.entry.time);
    const xi = barIndexAt(times, t.exit.time);
    if (ei < 0 || xi < 0) {
      unplaced.push(t.index);
      continue;
    }
    const dir = t.direction === 'long' ? 1 : -1;
    const qty = t.qty ?? 1;
    const signed = dir * qty;
    // The leg is marked from its entry bar through the bar BEFORE its exit
    // bar; at the exit bar it is realised, so marking it there as well would
    // count the same move twice.
    dQty[ei] += signed;
    dBasis[ei] += signed * t.entry.price;
    dQty[xi] -= signed;
    dBasis[xi] -= signed * t.entry.price;
    dRealised[xi] += t.net_profit ?? 0;
    commissionSeen += t.commission ?? 0;
    placed.push({ trade: t, entry_bar: ei, exit_bar: xi });
  }

  const equity = new Float64Array(n);
  const realisedCurve = new Float64Array(n);
  const inMarket = new Uint8Array(n);
  // Position state is kept, not just the mark it produces: the intrabar
  // envelope has to re-mark the same position at each bar's extremes, and
  // re-deriving it from the trade rows a second time is a second chance to
  // get the join wrong.
  const qtyCurve = new Float64Array(n);
  const basisCurve = new Float64Array(n);
  let qty = 0;
  let basis = 0;
  let realised = 0;
  for (let i = 0; i < n; i++) {
    qty += dQty[i];
    basis += dBasis[i];
    realised += dRealised[i];
    realisedCurve[i] = realised;
    // Float error accumulates over 21k signed additions; snap the flat state
    // to exactly flat so a closed book does not leave a residue.
    if (Math.abs(qty) < 1e-9) {
      qty = 0;
      basis = 0;
    }
    inMarket[i] = qty === 0 ? 0 : 1;
    qtyCurve[i] = qty;
    basisCurve[i] = basis;
    equity[i] = realised + (qty * close[i] - basis);
  }

  return {
    equity,
    realised: realisedCurve,
    qty: qtyCurve,
    basis: basisCurve,
    in_market: inMarket,
    placed,
    legs_placed: placed.length,
    legs_outside_loaded_history: unplaced.length,
    ...(unplaced.length
      ? {
          unplaced_trade_indexes: unplaced.slice(0, 20),
          history_short_error:
            'One or more trade legs fall before the first loaded bar. The curve would silently omit them. Load more history before reconstructing, or narrow the book.',
        }
      : {}),
    open_rows_excluded: openExcluded,
    commission_realised: r(commissionSeen, 4),
    unrealised_excludes_commission: true,
  };
}

/** Mean and sample (n-1) standard deviation. */
function meanSd(a) {
  const n = a.length;
  if (!n) return { n: 0, mean: null, sd: null };
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  const mean = s / n;
  if (n < 2) return { n, mean, sd: null };
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - mean;
    v += d * d;
  }
  return { n, mean, sd: Math.sqrt(v / (n - 1)) };
}

/**
 * Peak-to-trough drawdown of a curve, with the timing.
 *
 * The curve is P&L, not balance, so the drawdown is reported in currency only.
 * A percentage drawdown needs an account base the report does not carry, and
 * inventing one would produce a number that looks comparable to TradingView's
 * `maxStrategyDrawDownPercent` and is not.
 */
export function maxDrawdown(curve, times) {
  let peak = curve.length ? curve[0] : 0;
  let peakAt = 0;
  let worst = 0;
  let troughAt = -1;
  let fromAt = -1;
  for (let i = 0; i < curve.length; i++) {
    if (curve[i] > peak) {
      peak = curve[i];
      peakAt = i;
    }
    const dd = peak - curve[i];
    if (dd > worst) {
      worst = dd;
      troughAt = i;
      fromAt = peakAt;
    }
  }
  return {
    max_drawdown: r(worst, 4),
    peak_bar: fromAt,
    trough_bar: troughAt,
    peak_time: fromAt >= 0 && times ? times[fromAt] : null,
    trough_time: troughAt >= 0 && times ? times[troughAt] : null,
    bars_peak_to_trough: troughAt >= 0 && fromAt >= 0 ? troughAt - fromAt : null,
  };
}

/**
 * Risk statistics from the reconstructed curve.
 *
 * Reported twice: over every bar, and over the bars the strategy was actually
 * in the market. The first is the number an account earns; the second removes
 * the flat bars, which for a strategy in the market a small fraction of the
 * time dominate the sample and drag the ratio toward zero. Neither is more
 * correct - they answer different questions, and quoting one without saying
 * which is how an unreproducible Sharpe gets into a report in the first place.
 */
export function curveStats(rec, bars) {
  const { times } = bars;
  const eq = rec.equity;
  const n = eq.length;
  if (n < 2) return { insufficient_bars: n };

  const delta = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) delta[i - 1] = eq[i] - eq[i - 1];

  const spanSeconds = (times[n - 1] - times[0]) / 1000;
  const periodsPerYear =
    spanSeconds > 0 ? (n - 1) / (spanSeconds / SECONDS_PER_YEAR) : null;

  const inMarketDelta = [];
  for (let i = 1; i < n; i++) if (rec.in_market[i - 1]) inMarketDelta.push(eq[i] - eq[i - 1]);

  const block = (arr, periods) => {
    const { n: cnt, mean, sd } = meanSd(arr);
    if (!cnt || sd == null) return { bars: cnt, insufficient: true };
    let dsq = 0;
    let downCount = 0;
    for (let i = 0; i < cnt; i++) {
      const d = arr[i] < 0 ? arr[i] : 0;
      if (d < 0) downCount++;
      dsq += d * d;
    }
    const downside = Math.sqrt(dsq / cnt);
    const ann = periods ? Math.sqrt(periods) : null;
    return {
      bars: cnt,
      mean_pnl_per_bar: r(mean, 8),
      sd_pnl_per_bar: r(sd, 8),
      downside_deviation: r(downside, 8),
      down_bars: downCount,
      sharpe: sd > 0 && ann ? r((mean / sd) * ann, 4) : null,
      sortino: downside > 0 && ann ? r((mean / downside) * ann, 4) : null,
    };
  };

  const barsInMarket = inMarketDelta.length;
  return {
    basis: 'per_bar_mark_to_market',
    method:
      'equity = realised(net of commission) + qty*close - costBasis; Sharpe/Sortino on per-bar dollar deltas, rf=0, sd n-1, Sortino downside averaged over all periods',
    bars: n,
    from_time: times[0],
    to_time: times[n - 1],
    span_days: r(spanSeconds / 86400, 3),
    periods_per_year: r(periodsPerYear, 1),
    periods_per_year_note:
      'Derived from the bars actually observed over the span, not from the nominal bar length. A 45S bar implies 700800 nominal periods a year; the observed figure is lower by the fraction of the week the market is closed.',
    time_in_market_pct: r((barsInMarket / (n - 1)) * 100, 2),
    net_profit: r(eq[n - 1], 4),
    all_bars: block(delta, periodsPerYear),
    in_market_bars: block(inMarketDelta, periodsPerYear),
    drawdown: maxDrawdown(eq, times),
    drawdown_note:
      'Computed from bar CLOSES, so it is a lower bound: an intrabar excursion deeper than any close is not visible at this resolution.',
  };
}

/**
 * Sharpe and Sortino as a function of SAMPLING FREQUENCY.
 *
 * This block exists because "Sharpe >= 2.3" is not a criterion until the
 * sampling interval is named. The same equity curve, resampled, gives wildly
 * different answers: annualising 45-second increments multiplies by
 * sqrt(~500,000) and rewards a curve made of many tiny independent steps,
 * while daily increments multiply by sqrt(~260) and are the convention almost
 * every published Sharpe uses. Neither is wrong. Quoting one without its
 * interval is.
 *
 * Buckets are cut on wall-clock boundaries from the epoch, and a bucket exists
 * only if a bar fell in it, so a closed market contributes no period rather
 * than a zero return. The delta of a bucket is the change in equity from the
 * last bar of the previous bucket to the last bar of this one, which makes the
 * buckets sum to the total exactly.
 */
export function samplingSensitivity(rec, bars, intervalsSeconds = [45, 60, 300, 3600, 86400]) {
  const { times, n } = bars;
  const eq = rec.equity;
  if (n < 2) return { insufficient_bars: n };
  const spanYears = (times[n - 1] - times[0]) / 1000 / SECONDS_PER_YEAR;

  const rows = intervalsSeconds.map((sec) => {
    const ms = sec * 1000;
    const marks = [];
    let bucket = Math.floor(times[0] / ms);
    for (let i = 1; i < n; i++) {
      const b = Math.floor(times[i] / ms);
      if (b !== bucket) {
        marks.push(eq[i - 1]);
        bucket = b;
      }
    }
    marks.push(eq[n - 1]);
    if (marks.length < 3) return { interval_seconds: sec, periods: marks.length, insufficient: true };
    const delta = [];
    for (let i = 1; i < marks.length; i++) delta.push(marks[i] - marks[i - 1]);
    return { interval_seconds: sec, ...ratios(delta, spanYears) };
  });

  return {
    rows,
    note:
      'One curve, several sampling intervals. A Sharpe threshold is only meaningful against a stated interval; the daily row is the one that compares to a conventionally-quoted Sharpe.',
  };
}

/**
 * Sharpe and Sortino for one series of increments, annualised by how many of
 * them were actually observed per year. Shared so every row of the sensitivity
 * table and the headline block are computed identically.
 */
function ratios(delta, spanYears) {
  const cnt = delta.length;
  const { mean, sd } = meanSd(delta);
  let dsq = 0;
  let down = 0;
  for (let i = 0; i < cnt; i++) {
    const d = delta[i] < 0 ? delta[i] : 0;
    if (d < 0) down++;
    dsq += d * d;
  }
  const downside = Math.sqrt(dsq / cnt);
  const perYear = spanYears > 0 ? cnt / spanYears : null;
  const ann = perYear ? Math.sqrt(perYear) : null;
  return {
    periods: cnt,
    periods_per_year: r(perYear, 1),
    mean_pnl: r(mean, 6),
    sd_pnl: r(sd, 6),
    down_periods: down,
    sharpe: sd > 0 && ann ? r((mean / sd) * ann, 4) : null,
    sortino: downside > 0 && ann ? r((mean / downside) * ann, 4) : null,
    // The raw ratio before annualisation. Carried because the annualisation
    // factor is the single largest lever on the headline number, and a reader
    // comparing against a third-party figure needs to know whether that figure
    // was annualised at all.
    sharpe_unannualised: sd > 0 ? r(mean / sd, 4) : null,
  };
}

/**
 * The same two ratios on PER-TRADE increments.
 *
 * Included because a per-trade Sharpe is what a trade-indexed curve can
 * produce, and comparing it against the per-bar figures shows how much of the
 * difference between this module and TradingView's number is sampling rather
 * than method.
 */
export function perTradeRatios(placed, bars) {
  const { times, n } = bars;
  if (!placed.length || n < 2) return { periods: 0, insufficient: true };
  const delta = placed.map((p) => p.trade.net_profit ?? 0);
  const spanYears = (times[n - 1] - times[0]) / 1000 / SECONDS_PER_YEAR;
  return { basis: 'per_closed_trade', ...ratios(delta, spanYears) };
}

/**
 * The excursion PATH of each leg, not just its extremum.
 *
 * HOW TRADINGVIEW COMPUTES dd/rn (measured 2026-09-10, 106 of 106 exact)
 * ---------------------------------------------------------------------
 * The first attempt at this scanned bar extremes from the entry bar to the
 * exit bar and matched ZERO of 106 rows. Three corrections, each isolated by
 * measurement, take it to a full match:
 *
 *   1. Excursions are on LEG EQUITY, not on price. A leg is charged its
 *      entry-side commission the instant it fills, so its equity starts at
 *      -entryCommission. Reported MAE is therefore the price excursion PLUS
 *      that commission, and reported MFE is the price excursion MINUS it.
 *      Measured as a dead-constant 0.11 on every row against a 0.22 round
 *      trip. This matters beyond bookkeeping: a stop level compared against a
 *      reported MAE is being compared against a number 0.11 larger than the
 *      price move that would trigger it.
 *   2. The EXIT BAR contributes its exit price, not its high and low. The
 *      position is gone once the fill happens; the rest of that bar's range
 *      belongs to nobody. Without this, 39 of 106 rows overstated MAE, one by
 *      2.58 -- every one of them a hard-stop exit whose bar ran on after the
 *      stop was taken.
 *   3. Both are FLOORED AT ZERO. Three rows never moved far enough in their
 *      favour to cover the entry commission; TradingView reports rn = 0 for
 *      them, not a small negative.
 *
 * The entry bar contributes its full range. A fill inside a bar cannot be
 * located more precisely than the bar, so an extreme that predates the fill is
 * counted -- and the full match says TradingView does the same.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Validation. Reproducing dd/rn from the bars proves the reconstruction agrees
 * with the report about which bars each leg spans; the equity curve is built
 * on the same join, so a full match is the curve's evidence too.
 *
 * Timing. `mae_at` is where in the leg's life the worst excursion fell, as a
 * fraction of its length. Whether winners take their heat early while losers
 * bleed late is a statement about the exit, and no extremum can answer it.
 */
export function excursionPaths(placed, bars, tolerance = 0.005) {
  const { high, low } = bars;
  const rows = [];
  let maeMatch = 0;
  let mfeMatch = 0;
  let compared = 0;

  for (const p of placed) {
    const t = p.trade;
    const entryCommission = (t.commission ?? 0) / 2;
    const { worst, best, worstAt, bestAt } = scanLeg(t, high, low, p.entry_bar, p.exit_bar);
    const held = p.exit_bar - p.entry_bar;
    rows.push({
      index: t.index,
      direction: t.direction,
      net_profit: t.net_profit,
      bars_held: held,
      mae_recomputed: r(worst, 4),
      mfe_recomputed: r(best, 4),
      mae_reported: t.mae,
      mfe_reported: t.mfe,
      // The price move that would actually trigger a stop, which is NOT the
      // reported MAE. Named separately so the two can never be confused.
      mae_price_only: r(Math.max(0, worst - entryCommission), 4),
      // Where the extreme fell in the leg's life: 0 = at entry, 1 = at exit.
      mae_at: held > 0 ? r((worstAt - p.entry_bar) / held, 4) : null,
      mfe_at: held > 0 ? r((bestAt - p.entry_bar) / held, 4) : null,
    });
    if (t.mae != null && t.mfe != null) {
      compared++;
      if (Math.abs(worst - t.mae) <= tolerance) maeMatch++;
      if (Math.abs(best - t.mfe) <= tolerance) mfeMatch++;
    }
  }

  return {
    rows,
    validation: {
      compared,
      mae_matches: maeMatch,
      mfe_matches: mfeMatch,
      tolerance,
      holds: compared > 0 && maeMatch === compared && mfeMatch === compared,
      model:
        'leg equity: price excursion from entry, plus/minus the entry-side commission, exit bar contributing its exit price rather than its range, floored at zero',
      note: 'Anything short of a full match means the reconstruction disagrees with the report about which bars a leg spans, or the excursion model has changed. The equity curve is built on the same join and inherits the disagreement.',
    },
  };
}

// --- Page-context JS ------------------------------------------------------

/**
 * Extend loaded price history until it covers `targetSec`.
 *
 * The series holds a rolling window sized to the viewport, NOT the strategy's
 * backtest range. Measured 2026-09-10: 372 loaded bars against a 21,518-bar
 * book. `requestMoreData(n)` extends it and is the same operation as scrolling
 * back, so it mutates only what is loaded - not the symbol, the resolution or
 * the study inputs. It does move `dateRange.backtest.from`, because the
 * backtest range follows the loaded bars, so the report MUST be re-read after
 * calling this and never paired with a report taken before it.
 *
 * Returns without requesting anything when history already reaches far enough.
 */
export function ensureHistoryJs(targetSec, chunk = 10000, maxRounds = 8) {
  return `
  (function() {
    var ms = ${'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries()'};
    var TARGET = ${Number(targetSec)};
    function snap() {
      var b = ms.bars();
      return { size: b.size(), first: b.firstIndex(), last: b.lastIndex(),
               t0: b.size() ? b.valueAt(b.firstIndex())[0] : null };
    }
    function more() {
      try { var v = ms.requestMoreDataAvailable();
            return (v && typeof v.value === 'function') ? v.value() : !!v; }
      catch (e) { return false; }
    }
    var started = snap();
    return new Promise(function (resolve) {
      var rounds = 0, log = [];
      (function step() {
        var cur = snap();
        if (cur.t0 != null && cur.t0 <= TARGET) return resolve({ covered: true, rounds: rounds, started: started, final: cur, log: log });
        if (!more()) return resolve({ covered: false, reason: 'end_of_data', rounds: rounds, started: started, final: cur, log: log });
        if (rounds >= ${Number(maxRounds)}) return resolve({ covered: false, reason: 'max_rounds', rounds: rounds, started: started, final: cur, log: log });
        rounds++;
        try { ms.requestMoreData(${Number(chunk)}); }
        catch (e) { return resolve({ covered: false, reason: 'request_failed', error: String(e), rounds: rounds, started: started, final: cur, log: log }); }
        var tries = 0;
        (function poll() {
          tries++;
          var s = snap();
          var loading = false; try { loading = ms.isLoading(); } catch (e) {}
          /* Growth alone is not the signal: the series can append the newest
             bar while the history request is still in flight. Require both a
             changed size and an idle series, and give up on a round rather
             than hanging the whole call. */
          if ((s.size !== cur.size && !loading) || tries > 80) {
            log.push({ round: rounds, size: s.size, t0: s.t0, polls: tries });
            if (s.size === cur.size) return resolve({ covered: false, reason: 'no_growth', rounds: rounds, started: started, final: s, log: log });
            step();
          } else setTimeout(poll, 250);
        })();
      })();
    });
  })()`;
}

/**
 * Read a slice of loaded bars as raw tuples.
 *
 * Sliced by SERIES INDEX, which is only meaningful within one read session:
 * the indices rebase whenever history is extended. The caller reads
 * firstIndex/lastIndex and slices in the same settled state, and every
 * downstream join is by time regardless.
 */
export function barsSliceJs(from, to) {
  return `
  (function() {
    var b = ${'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries()'}.bars();
    var lo = Math.max(b.firstIndex(), ${Number(from)});
    var hi = Math.min(b.lastIndex(), ${Number(to)});
    var out = [];
    for (var i = lo; i <= hi; i++) { var v = b.valueAt(i); if (v) out.push(v); }
    return { from: lo, to: hi, rows: out };
  })()`;
}

/** Series extent, read in one round trip so a slice loop cannot straddle a reload. */
export const BARS_EXTENT_JS = `
  (function() {
    var b = ${'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries()'}.bars();
    if (!b.size()) return { size: 0 };
    return { size: b.size(), first: b.firstIndex(), last: b.lastIndex(),
             t_first: b.valueAt(b.firstIndex())[0], t_last: b.valueAt(b.lastIndex())[0] };
  })()`;

/**
 * Excursion timing, summarised.
 *
 * The question this exists to answer, in the user's words: do runners take
 * their heat early while losers bleed late? `mae_at` is the fraction of a
 * leg's life at which its worst excursion fell, so the answer is a comparison
 * of that distribution between winners and losers. `first_quarter` /
 * `last_quarter` are reported alongside the percentiles because a median of
 * 0.5 is equally consistent with "always mid-trade" and "half early, half
 * late", and those are different findings.
 *
 * Arithmetic is borrowed from aggregate.js rather than repeated, so a walk-
 * forward comparing two windows is comparing numbers computed identically.
 */
export function summariseExcursionPaths(rows) {
  const timed = rows.filter((x) => x.mae_at != null);
  const winners = timed.filter((x) => x.net_profit > 0);
  const losers = timed.filter((x) => x.net_profit <= 0);
  const block = (set, key) => {
    const v = set.map((x) => x[key]);
    return {
      ...describeStat(v),
      first_quarter: v.filter((x) => x <= 0.25).length,
      last_quarter: v.filter((x) => x >= 0.75).length,
    };
  };
  return {
    n: timed.length,
    mae_at: {
      all: block(timed, 'mae_at'),
      winners: block(winners, 'mae_at'),
      losers: block(losers, 'mae_at'),
    },
    mfe_at: {
      winners: block(winners, 'mfe_at'),
      losers: block(losers, 'mfe_at'),
    },
    reading:
      'mae_at is the fraction of a leg\'s life at which its worst excursion occurred: 0 = immediately after entry, 1 = at the exit. A winner distribution concentrated near 0 with a loser distribution concentrated near 1 is the "runners take heat early, losers bleed late" pattern; anything else refutes it.',
  };
}

/**
 * Daily equity increments, bucketed by calendar day.
 *
 * `offsetSeconds` shifts the day boundary. It exists because the boundary
 * TradingView uses is not observable, and the identification below is only
 * honest if it is shown to hold across every plausible choice rather than the
 * one that flatters it.
 */
export function dailyIncrements(rec, bars, offsetSeconds = 0) {
  const last = new Map();
  for (let i = 0; i < bars.n; i++) {
    last.set(Math.floor((bars.times[i] / 1000 + offsetSeconds) / 86400), rec.equity[i]);
  }
  const days = [...last.keys()].sort((a, b) => a - b);
  const inc = [];
  for (let i = 1; i < days.length; i++) inc.push(last.get(days[i]) - last.get(days[i - 1]));
  return { days: days.length, increments: inc };
}

/**
 * Peak-to-trough drawdown and trough-to-peak run-up of an arbitrary series.
 *
 * Both from one pass so they describe the same series. Reporting a run-up from
 * one basis against a drawdown from another is the exact error this module
 * found in the TradingView figures.
 */
export function drawdownAndRunup(series) {
  if (!series.length) return { drawdown: null, runup: null };
  let peak = series[0];
  let trough = series[0];
  let dd = 0;
  let ru = 0;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v > peak) peak = v;
    if (peak - v > dd) dd = peak - v;
    if (v < trough) trough = v;
    if (v - trough > ru) ru = v - trough;
  }
  return { drawdown: r(dd, 4), runup: r(ru, 4) };
}

/**
 * The same mark-to-market curve, re-marked at each bar HIGH and LOW.
 *
 * TradingView marks intrabar. Measured 2026-09-11 on the 45S book: reported
 * `maxRunUp` 275.04 against 275.82 from this envelope and 270.23 from close
 * marks, so the envelope identifies the curve the TradingView run-up is taken
 * from to within 0.3 percent.
 *
 * Order within a bar is unknown, so each bar contributes both of its extremes.
 * That is deliberately the widest reading: it is an envelope, not a path, and
 * it bounds what the position actually experienced.
 */
export function intrabarEnvelope(rec, bars) {
  const seq = [0];
  for (let i = 0; i < bars.n; i++) {
    const q = rec.qty[i];
    const realised = rec.realised[i];
    if (q === 0) {
      seq.push(realised, realised);
      continue;
    }
    const basis = rec.basis[i];
    const adverse = q > 0 ? bars.low[i] : bars.high[i];
    const favourable = q > 0 ? bars.high[i] : bars.low[i];
    seq.push(realised + (q * adverse - basis), realised + (q * favourable - basis));
  }
  return { ...drawdownAndRunup(seq), basis: 'per_bar_intrabar_envelope', marks: seq.length };
}

/**
 * Drawdown and run-up of the realised curve alone: one point per closed leg,
 * in exit order, carrying no unrealised mark.
 *
 * This is what `trades[].cp.v` traces, and it is the curve a trade-indexed
 * Sharpe or drawdown is computed on. Kept so the two bases can be compared
 * rather than confused.
 */
export function closedTradeCurve(placed) {
  const legs = placed
    .map((p) => ({ t: p.trade.exit?.time ?? 0, pnl: p.trade.net_profit ?? 0 }))
    .sort((a, b) => a.t - b.t);
  let cum = 0;
  const series = [0];
  for (const l of legs) series.push((cum += l.pnl));
  return { ...drawdownAndRunup(series), basis: 'per_closed_trade', legs: legs.length };
}

/**
 * Which method produces the TradingView numbers, tested rather than assumed.
 *
 * Findings, measured 2026-09-11 on the live 45S book (101 closed legs):
 *
 *   Sharpe. The TradingView figure is a NON-ANNUALISED DAILY Sharpe. Reported
 *   0.3701; this curve gives 0.3507 on UTC days with a sample sd and 0.3640
 *   with a population sd, and spans 0.25 to 0.37 across every day boundary
 *   tried. Every other sampling interval un-annualised is an order of
 *   magnitude away (per-bar 0.0064, hourly 0.0572, per-trade 0.1229) and every
 *   annualised figure is 4 to 7. So the interval is identified; the residual
 *   is the day boundary and the sd convention, neither of them observable.
 *
 *   The consequence is the point. A Sharpe threshold asserted against the
 *   TradingView display is a threshold on a DAILY ratio: 2.3 there is about 36
 *   annualised, which nothing real reaches. A threshold must name its method.
 *   The ratio between the two conventions is sqrt(trading days per year),
 *   about 15.9.
 *
 *   Drawdown. The TradingView value does NOT come from the curve the
 *   TradingView run-up comes from. Run-up 275.04 reported against 275.82 from
 *   the intrabar envelope identifies that curve; on that same curve the
 *   drawdown is 121.96, and TradingView reports 60.68, a factor of 2.01. The
 *   closed-trade curve gives 57.95, close but not equal, so a closed-trade
 *   basis does not explain it either. Reported as a bracket: what the position
 *   experienced is about twice what TradingView shows, and the TradingView
 *   drawdown is not reconcilable with the TradingView run-up.
 */
export function tradingviewComparison(rec, bars, performance, curveStatsOut) {
  const tvSharpe = performance?.sharpe_ratio ?? null;
  const boundaries = [0, -5, -4, 2, 8];
  const daily = boundaries.map((h) => {
    const { days, increments } = dailyIncrements(rec, bars, h * 3600);
    const m = meanSd(increments);
    const pop =
      increments.length > 1 ? m.sd * Math.sqrt((increments.length - 1) / increments.length) : null;
    return {
      day_boundary_utc_hours: h,
      days,
      sharpe_sample_sd: m.sd ? r(m.mean / m.sd, 4) : null,
      sharpe_population_sd: pop ? r(m.mean / pop, 4) : null,
    };
  });
  const envelope = intrabarEnvelope(rec, bars);
  const closed = closedTradeCurve(rec.placed);
  const perBar = drawdownAndRunup([0, ...rec.equity]);

  // A daily-SAMPLED curve, because the Sharpe is daily and it costs one pass
  // to ask whether the drawdown is measured on the same series. Sampling
  // coarsens a curve, so this is always between the closed-trade figure and
  // the per-bar one, and a match would explain the gap rather than restate it.
  const dailySeries = (() => {
    const { increments } = dailyIncrements(rec, bars, 0);
    const cum = [0];
    for (const d of increments) cum.push(cum[cum.length - 1] + d);
    return { ...drawdownAndRunup(cum), basis: 'daily_sampled_utc', days: increments.length };
  })();

  // The comparison a reader actually wants: how far each candidate is from the
  // reported pair. Computed rather than asserted, so the identification is
  // re-made on every book instead of being inherited from the one it was found
  // on — this whole block reproduced on a second, differently-configured book.
  const gap = (v, t) => (v == null || t == null || !t ? null : r(((v - t) / t) * 100, 2));
  const tvDd = performance?.max_drawdown ?? null;
  const tvRu = performance?.max_run_up ?? null;
  const candidates = [
    ['closed_trade_curve', closed],
    ['per_bar_close_marks', perBar],
    ['intrabar_envelope', envelope],
    ['daily_sampled', dailySeries],
  ].map(([name, c]) => ({
    basis: name,
    drawdown: c.max_drawdown ?? c.drawdown ?? null,
    runup: c.max_run_up ?? c.runup ?? null,
    drawdown_gap_pct: gap(c.max_drawdown ?? c.drawdown, tvDd),
    runup_gap_pct: gap(c.max_run_up ?? c.runup, tvRu),
  }));
  const bestRunup = candidates
    .filter((c) => c.runup_gap_pct != null)
    .sort((a, b) => Math.abs(a.runup_gap_pct) - Math.abs(b.runup_gap_pct))[0] ?? null;
  const bestDd = candidates
    .filter((c) => c.drawdown_gap_pct != null)
    .sort((a, b) => Math.abs(a.drawdown_gap_pct) - Math.abs(b.drawdown_gap_pct))[0] ?? null;
  // The conventional annualiser for a daily Sharpe, stated as a constant
  // because the whole point is that a threshold has to name one.
  const TRADING_DAYS = 252;
  const factor = Math.sqrt(TRADING_DAYS);

  return {
    sharpe: {
      tradingview_reported: tvSharpe == null ? null : r(tvSharpe, 4),
      identified_as: 'non-annualised daily Sharpe on the equity curve',
      this_curve_daily_unannualised: daily,
      tradingview_restated_annualised: tvSharpe == null ? null : r(tvSharpe * factor, 4),
      this_curve_annualised_per_bar: curveStatsOut?.all_bars?.sharpe ?? null,
      annualiser: 'sqrt(' + TRADING_DAYS + ')',
      // Computed from THIS curve, not quoted from the book the identification
      // was first made on. An evidence line carrying another run's constants
      // reads as though it describes the run it is printed inside.
      other_intervals_unannualised: {
        per_bar: curveStatsOut?.all_bars?.sharpe == null ? null : r(curveStatsOut.all_bars.sharpe / Math.sqrt(curveStatsOut.periods_per_year ?? 1), 4),
        per_trade: (() => {
          // placed[] rows wrap the trade: { trade, entry_bar, exit_bar }.
          const m = meanSd((rec.placed || []).map((p) => p.trade?.net_profit ?? 0));
          return m.sd ? r(m.mean / m.sd, 4) : null;
        })(),
      },
      evidence:
        'Compare the daily rows above against tradingview_reported. Measured on two differently-configured books: no other sampling interval comes within an order of magnitude un-annualised, ' +
        'and the daily rows bracket the reported figure across every day boundary tried. The residual is the day boundary and whether the sd is sample or population, neither of which TradingView exposes.',
      consequence:
        'A Sharpe acceptance threshold read against the TradingView display is a threshold on a DAILY ratio. Multiply it by sqrt(252), about 15.9, before comparing it with an annualised figure. A threshold must name the method it is asserted against.',
    },
    drawdown: {
      tradingview_reported: tvDd,
      tradingview_runup_reported: tvRu,
      per_bar_close_marks: perBar,
      intrabar_envelope: envelope,
      closed_trade_curve: closed,
      daily_sampled: dailySeries,
      // Ranked by distance from the reported pair, so the identification is
      // visible as a measurement rather than asserted in prose.
      candidates,
      closest_to_reported_runup: bestRunup?.basis ?? null,
      closest_to_reported_drawdown: bestDd?.basis ?? null,
      curve_identified_by_runup:
        'Run-up is what identifies the curve: the reported figure matches the intrabar envelope to within a fraction of a percent, and the closed-trade curve cannot reach it at all.',
      unreconciled:
        'On that same envelope the drawdown is far larger than TradingView reports, and no other candidate equals it either. The TradingView drawdown is not reconcilable with the TradingView run-up — they are not measurements of one curve. ' +
        'Treat the envelope figure as what the position actually experienced and the reported drawdown as an understatement.',
    },
  };
}

/**
 * The excursion model, in one place.
 *
 * Three corrections, each arrived at by measurement against TradingView own
 * `dd`/`rn` and each load-bearing:
 *
 *   1. the leg pays half its round-trip commission on entry, so that half is
 *      ADDED to the adverse excursion and TAKEN OFF the favourable one;
 *   2. the exit bar contributes its EXIT PRICE, not its range - a hard stop
 *      fills at the stop and the rest of that bar never happened to the leg;
 *   3. both are floored at zero, which is structural here because `worst` and
 *      `best` start at zero and only ever increase.
 *
 * Shared by the 45S validation scan and the finer-resolution refinement so the
 * two cannot drift apart. A refinement computed by a different model would not
 * be comparable to the figure it is refining, which is the whole point of it.
 */
function scanLeg(t, high, low, entryBar, exitBar) {
  const dir = t.direction === 'long' ? 1 : -1;
  const qty = t.qty ?? 1;
  const e = t.entry.price;
  const entryCommission = (t.commission ?? 0) / 2;
  let worst = 0;
  let best = 0;
  let worstAt = entryBar;
  let bestAt = entryBar;
  for (let i = entryBar; i <= exitBar; i++) {
    const hi = i === exitBar ? t.exit.price : high[i];
    const lo = i === exitBar ? t.exit.price : low[i];
    const adverse = (dir === 1 ? e - lo : hi - e) * qty + entryCommission;
    const favourable = (dir === 1 ? hi - e : e - lo) * qty - entryCommission;
    if (adverse > worst) {
      worst = adverse;
      worstAt = i;
    }
    if (favourable > best) {
      best = favourable;
      bestAt = i;
    }
  }
  return { worst, best, worstAt, bestAt };
}

/**
 * Re-scan the same legs against a FINER bar series.
 *
 * This is the route to a true intrabar MAE. The scanner reproduces the
 * TradingView `dd`/`rn` on every row at 45S, so it is a method validated
 * against a known-good reference; running it against 5S or 1S bars over the
 * same holding periods measures what the position actually experienced
 * between the coarse bars. No Pine change, no magnifier, no toolbar path.
 *
 * WHAT BOUNDS IT. Seconds history is capped at roughly 21,000 bars at every
 * resolution (measured 2026-09-11: 45S reaches 366h, 5S 30.5h, 1S 6.5h, each
 * stopping on `end_of_data`). The cap is a BAR COUNT, so finer resolution buys
 * detail by spending span. Only legs lying wholly inside the finer window can
 * be refined, and the rest are reported as uncovered rather than dropped.
 *
 * WHAT IT ACTUALLY FOUND, AND WHY THE ANSWER IS ZERO. Run 2026-09-11 against
 * 5S (15 legs covered) and 1S (6 legs): every refined MAE and MFE equalled the
 * 45S figure EXACTLY - a delta of 0, not a small one. That is an identity, not
 * a measurement. A coarse bar high is by construction the maximum of the fine
 * bar highs inside it, so a scan of bar extremes returns the same extreme at
 * any resolution; and every entry and exit in the book falls on a 45S bar
 * boundary (101 of 101), so there is no partial-bar effect at the ends either.
 *
 * So an excursion taken from bar extremes is RESOLUTION-INVARIANT, and the
 * reported MAE is already the true worst excursion rather than an
 * understatement of it. This is also why Deep Backtesting gave 99 of 100
 * identical MAE figures: same identity, not a failure of that route.
 *
 * What finer bars do buy is the PATH. `mae_at` and `mfe_at` are quantised by
 * the bar count of the leg, and short legs are badly quantised at 45S - a leg
 * of 7 bars can only place its extreme at sevenths. At 5S the same leg has 63
 * points. Anything that conditions on WHEN a leg took its heat should be
 * measured here, not on the coarse series.
 *
 * What finer bars do NOT buy is any change to whether a price level was
 * touched. A stop level fitted against these excursions needs no detalization
 * correction; what resolution genuinely governs is fill SEQUENCING within a
 * bar, which is an execution question and not a measurement one.
 */
export function refineExcursions(placed, fine, coarseSeconds) {
  const rows = [];
  const uncovered = [];
  const first = fine.n ? fine.times[0] : null;
  const last = fine.n ? fine.times[fine.n - 1] : null;
  for (const p of placed) {
    const t = p.trade;
    if (first == null || t.entry.time < first || t.exit.time > last) {
      uncovered.push(t.index);
      continue;
    }
    const ei = barIndexAt(fine.times, t.entry.time);
    const xi = barIndexAt(fine.times, t.exit.time);
    if (ei < 0 || xi < 0 || xi < ei) {
      uncovered.push(t.index);
      continue;
    }
    const { worst, best, worstAt, bestAt } = scanLeg(t, fine.high, fine.low, ei, xi);
    const held = xi - ei;
    const entryCommission = (t.commission ?? 0) / 2;
    rows.push({
      index: t.index,
      direction: t.direction,
      net_profit: t.net_profit,
      fine_bars_held: held,
      mae_reported: t.mae,
      mae_refined: r(worst, 4),
      mae_delta: t.mae == null ? null : r(worst - t.mae, 4),
      mfe_reported: t.mfe,
      mfe_refined: r(best, 4),
      mfe_delta: t.mfe == null ? null : r(best - t.mfe, 4),
      // The move a price stop would actually see, at the finer resolution.
      mae_price_only_refined: r(Math.max(0, worst - entryCommission), 4),
      mae_at: held > 0 ? r((worstAt - ei) / held, 4) : null,
      mfe_at: held > 0 ? r((bestAt - ei) / held, 4) : null,
    });
  }
  const deltas = rows.map((x) => x.mae_delta).filter((v) => v != null);
  const grew = deltas.filter((v) => v > 0.005).length;
  const shrank = deltas.filter((v) => v < -0.005).length;
  return {
    rows,
    coverage: {
      legs_refined: rows.length,
      legs_uncovered: uncovered.length,
      uncovered_trade_indexes: uncovered.slice(0, 20),
      fine_bars: fine.n,
      fine_from: first,
      fine_to: last,
      fine_span_hours: first == null ? null : r((last - first) / 3600000, 2),
      coarse_seconds: coarseSeconds ?? null,
      note: 'Legs outside the finer window are not refined and are NOT dropped from any conclusion silently. A stop level fitted on the refined subset alone is fitted on the most recent bars only.',
    },
    mae_shift: {
      ...describeStat(deltas),
      legs_where_mae_grew: grew,
      legs_where_mae_shrank: shrank,
      note: 'Measured 2026-09-11 at both 5S and 1S: every delta was exactly zero. A bar high is the maximum of the highs inside it, so this is expected to stay zero whenever entries and exits land on bar boundaries. A NON-zero delta here is therefore a finding about the join or the feed, not about detalization, and should be investigated rather than adopted.',
    },
  };
}

/**
 * Size a give-back floor BEFORE fitting one.
 *
 * The shape the excursion timing points at is wide-early, tightening-later:
 * winners take their heat in the first few bars and never revisit it, losers
 * bleed late. Expressed as an MFE trigger rather than a bar count it has ONE
 * parameter and is scale-free across volatility regimes, which matters because
 * the effective sample is about three trades a week (measured across eight
 * disjoint windows) and will not support more.
 *
 * THE RULE. Once a leg has run `arm` dollars in its favour, it may not close
 * below `floor` dollars of leg equity. Nothing else changes: no initial stop,
 * no target.
 *
 * WHY SIZE IT FIRST. If the money sitting between a candidate arm point and
 * the actual exit is small, the rule is not worth a parameter however clean
 * the separation looks. That is a cheaper question than fitting, and it is the
 * one that decides whether fitting is justified at all.
 *
 * INTRABAR ORDERING IS NOT OBSERVABLE, so it is bracketed rather than assumed.
 * On the bar that arms the rule, whether the high came before the low decides
 * whether that same bar can also stop the leg. `same_bar_can_stop` true is the
 * pessimistic reading and false the optimistic one; both are returned. This is
 * the one place resolution genuinely matters - see `refineExcursions`, where a
 * finer series changes no extreme but does change sequencing.
 */
export function tighteningBenefit(placed, bars, arms = [1, 2, 3, 4, 5, 6], floor = 0) {
  const { high, low } = bars;
  const levels = [];
  for (const arm of arms) {
    for (const sameBar of [true, false]) {
      let armed = 0;
      let stopped = 0;
      let deltaWinners = 0;
      let deltaLosers = 0;
      let winnersHurt = 0;
      let losersHelped = 0;
      const cutWinners = [];
      for (const p of placed) {
        const t = p.trade;
        const dir = t.direction === 'long' ? 1 : -1;
        const qty = t.qty ?? 1;
        const e = t.entry.price;
        const half = (t.commission ?? 0) / 2;
        // Leg equity at a price, on the same convention the reported dd and rn
        // use: favourable move less the entry-side commission.
        const eq = (price) => dir * (price - e) * qty - half;
        let runMfe = -Infinity;
        let armBar = -1;
        let stopBar = -1;
        for (let i = p.entry_bar; i <= p.exit_bar; i++) {
          const hi = i === p.exit_bar ? t.exit.price : high[i];
          const lo = i === p.exit_bar ? t.exit.price : low[i];
          const up = eq(dir === 1 ? hi : lo);
          const down = eq(dir === 1 ? lo : hi);
          if (armBar >= 0 && (sameBar || i > armBar) && down <= floor) {
            stopBar = i;
            break;
          }
          if (up > runMfe) runMfe = up;
          if (armBar < 0 && runMfe >= arm) {
            armBar = i;
            // Re-test this bar under the pessimistic reading: the low may have
            // come after the high that armed it.
            if (sameBar && down <= floor) {
              stopBar = i;
              break;
            }
          }
        }
        if (armBar < 0) continue;
        armed++;
        const actual = t.net_profit ?? 0;
        if (stopBar < 0) continue;
        stopped++;
        // Exiting at the floor still pays the exit-side commission.
        const counterfactual = floor - half;
        const delta = counterfactual - actual;
        if (actual > 0) {
          deltaWinners += delta;
          if (delta < -0.005) winnersHurt++;
          cutWinners.push({ index: t.index, actual: r(actual, 2), delta: r(delta, 2) });
        } else {
          deltaLosers += delta;
          if (delta > 0.005) losersHelped++;
        }
      }
      levels.push({
        arm,
        floor,
        same_bar_can_stop: sameBar,
        legs_armed: armed,
        legs_stopped: stopped,
        delta_from_losers: r(deltaLosers, 2),
        delta_from_winners: r(deltaWinners, 2),
        delta_total: r(deltaLosers + deltaWinners, 2),
        winners_hurt: winnersHurt,
        losers_helped: losersHelped,
        biggest_winners_cut: cutWinners.sort((a, b) => a.delta - b.delta).slice(0, 3),
      });
    }
  }
  return {
    basis: 'counterfactual give-back floor on the reconstructed path',
    legs: placed.length,
    levels,
    assumptions: [
      'The floor fills exactly at the floor price: no slippage and no gap through it. Both make the measured benefit optimistic.',
      'Arming and stopping are evaluated on bar extremes, so a leg that armed and stopped inside one bar is counted according to same_bar_can_stop rather than known.',
      'Everything else about the strategy is held fixed. A floor that changes an exit also changes what capital was free for the next entry, and that second-order effect is NOT modelled.',
    ],
    reading:
      'delta_total is what the rule would have added over this book. Compare it against the parameter it costs and against the spread between windows, not against zero: the effective sample is about three trades a week, so a small positive total is not evidence.',
  };
}
