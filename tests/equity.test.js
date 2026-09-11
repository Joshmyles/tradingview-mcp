/**
 * Per-bar equity reconstruction.
 *
 * Pure, so no live chart. Pinned because every risk number the programme
 * quotes now comes through here, and because the excursion model encoded in
 * `excursionPaths` was arrived at by measurement against 106 live rows — a
 * refactor that "simplifies" any one of its three corrections silently breaks
 * the match that is the curve's only evidence of correctness.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  barIndexAt,
  closedTradeCurve,
  curveStats,
  drawdownAndRunup,
  intrabarEnvelope,
  excursionPaths,
  maxDrawdown,
  perTradeRatios,
  prepareBars,
  reconstructEquity,
  refineExcursions,
  samplingSensitivity,
  summariseExcursionPaths,
  tighteningBenefit,
} from '../src/internals/equity.js';

// Ten 45-second bars. Times are SECONDS here, as `bars().valueAt()` returns
// them; prepareBars converts to the milliseconds the trade rows use.
const T0 = 1787695320;
const BAR = 45;
const raw = [
  // [time, open, high, low, close, volume]
  [T0 + 0 * BAR, 100, 100.2, 99.8, 100, 1],
  [T0 + 1 * BAR, 100, 100.4, 99.6, 100, 1],
  [T0 + 2 * BAR, 100, 101.0, 99.0, 100.5, 1],
  [T0 + 3 * BAR, 100.5, 102.0, 98.0, 99, 1],
  [T0 + 4 * BAR, 99, 103.0, 99.5, 102, 1],
  [T0 + 5 * BAR, 102, 108.0, 97.0, 104, 1], // exit bar: range must be ignored
  [T0 + 6 * BAR, 104, 104.5, 103.5, 104, 1],
  [T0 + 7 * BAR, 104, 104.5, 103.5, 104, 1],
  [T0 + 8 * BAR, 104, 104.5, 103.5, 104, 1],
  [T0 + 9 * BAR, 104, 104.5, 103.5, 104, 1],
];
const bars = prepareBars(raw);
const at = (i) => (T0 + i * BAR) * 1000;

const LONG = {
  index: 0,
  direction: 'long',
  qty: 1,
  entry: { time: at(2), price: 100, tag: 'B', tag_tokens: ['B'] },
  exit: { time: at(5), price: 104, tag: 'X', tag_tokens: ['X'] },
  net_profit: 3.78,
  commission: 0.22,
  // What TradingView reports for this leg under the measured model.
  mae: 2.11,
  mfe: 3.89,
};

describe('barIndexAt', () => {
  it('returns the bar covering the instant, by open time', () => {
    assert.equal(barIndexAt(bars.times, at(3)), 3);
    assert.equal(barIndexAt(bars.times, at(3) + 44_000), 3, 'mid-bar still lands on that bar');
    assert.equal(barIndexAt(bars.times, at(9) + 10 ** 9), 9, 'past the last bar clamps forward');
  });

  it('refuses to guess for an instant before loaded history', () => {
    // -1, never 0: clamping would mark a trade against the wrong bar and the
    // curve would look fine.
    assert.equal(barIndexAt(bars.times, at(0) - 1), -1);
  });
});

describe('excursionPaths', () => {
  const rec = reconstructEquity([LONG], bars);
  const { rows, validation } = excursionPaths(rec.placed, bars);

  it('reproduces the reported MAE and MFE exactly', () => {
    assert.equal(validation.compared, 1);
    assert.equal(validation.mae_matches, 1);
    assert.equal(validation.mfe_matches, 1);
    assert.equal(validation.holds, true);
  });

  it('adds the entry-side commission to MAE and takes it off MFE', () => {
    // Worst price excursion is bar 3 (low 98) = 2.00; reported MAE is 2.11.
    assert.equal(rows[0].mae_recomputed, 2.11);
    assert.equal(rows[0].mae_price_only, 2, 'the move that would trigger a price stop is NOT the reported MAE');
    // Best is the exit at 104 = 4.00; reported MFE is 3.89.
    assert.equal(rows[0].mfe_recomputed, 3.89);
  });

  it('ignores the exit bar range and uses the exit price', () => {
    // Bar 5 has low 97 and high 108. Honouring them would give MAE 3.11 and
    // MFE 7.89. Both are absent, so the clip is doing the work.
    assert.notEqual(rows[0].mae_recomputed, 3.11);
    assert.notEqual(rows[0].mfe_recomputed, 7.89);
  });

  it('floors both at zero when the move never covers the commission', () => {
    const flat = {
      ...LONG,
      index: 1,
      // Entered at the bar high, so the leg never moves in its favour at all.
      entry: { time: at(6), price: 104.5 },
      exit: { time: at(7), price: 104.3 },
      net_profit: -0.42,
      mae: 1.11, // 104.5 - 103.5, plus the entry commission
      mfe: 0,
    };
    const r2 = reconstructEquity([flat], bars);
    const p2 = excursionPaths(r2.placed, bars);
    assert.equal(p2.rows[0].mfe_recomputed, 0, 'a negative MFE is reported as zero, as TradingView does');
    assert.equal(p2.rows[0].mae_recomputed, 1.11);
    assert.equal(p2.validation.holds, true);
  });

  it('reports where in the leg the extreme fell', () => {
    // Worst at bar 3 of a leg spanning bars 2..5: one third of the way in.
    assert.equal(rows[0].mae_at, 0.3333);
    assert.equal(rows[0].mfe_at, 1, 'the best point was the exit itself');
  });
});

describe('reconstructEquity', () => {
  it('marks the position bar by bar and realises it at the exit bar', () => {
    const rec = reconstructEquity([LONG], bars);
    assert.equal(rec.legs_placed, 1);
    const eq = [...rec.equity].map((v) => Math.round(v * 100) / 100);
    assert.deepEqual(eq, [0, 0, 0.5, -1, 2, 3.78, 3.78, 3.78, 3.78, 3.78]);
  });

  it('is flat before the entry and after the exit', () => {
    const rec = reconstructEquity([LONG], bars);
    assert.deepEqual([...rec.in_market], [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it('excludes an open row rather than marking a moving price', () => {
    const rec = reconstructEquity([LONG, { ...LONG, index: 9, is_open: true }], bars);
    assert.equal(rec.legs_placed, 1);
    assert.equal(rec.open_rows_excluded, 1);
  });

  it('refuses a leg that starts before loaded history instead of dropping it', () => {
    const early = { ...LONG, index: 5, entry: { time: at(0) - 60_000, price: 100 } };
    const rec = reconstructEquity([early], bars);
    assert.equal(rec.legs_placed, 0);
    assert.equal(rec.legs_outside_loaded_history, 1);
    assert.match(rec.history_short_error, /Load more history/);
  });

  it('nets offsetting legs to exactly flat', () => {
    const short = {
      ...LONG,
      index: 1,
      direction: 'short',
      entry: { time: at(2), price: 100 },
      exit: { time: at(5), price: 104 },
      net_profit: -4.22,
    };
    const rec = reconstructEquity([LONG, short], bars);
    // Long and short of the same size over the same bars cancel, so every
    // marked bar is worth exactly zero and only the realised legs remain.
    assert.equal(Math.round(rec.equity[3] * 100) / 100, 0);
    assert.equal(Math.round(rec.equity[9] * 100) / 100, -0.44);
  });
});

describe('maxDrawdown', () => {
  it('finds the peak-to-trough and says when', () => {
    const rec = reconstructEquity([LONG], bars);
    const dd = maxDrawdown(rec.equity, bars.times);
    assert.equal(dd.max_drawdown, 1.5); // 0.5 at bar 2 down to -1 at bar 3
    assert.equal(dd.peak_bar, 2);
    assert.equal(dd.trough_bar, 3);
    assert.equal(dd.bars_peak_to_trough, 1);
  });
});

describe('curveStats', () => {
  const rec = reconstructEquity([LONG], bars);
  const s = curveStats(rec, bars);

  it('annualises from observed bars, not from the nominal bar length', () => {
    // Nine 45-second gaps with no market closure between them, so the observed
    // rate is the full-year rate: 31557600 / 45. That is a JULIAN year
    // (365.25 days) = 701280, not the 365-day 700800 — the constant is stated
    // in the module and this pins it.
    assert.equal(Math.round(s.periods_per_year), 701280);
  });

  it('ends at the realised total', () => {
    assert.equal(s.net_profit, 3.78);
  });

  it('reports the in-market sample separately from every bar', () => {
    assert.equal(s.all_bars.bars, 9);
    assert.equal(s.in_market_bars.bars, 3);
    assert.notEqual(s.all_bars.sharpe, s.in_market_bars.sharpe);
  });

  it('says which method produced the ratios', () => {
    assert.match(s.method, /rf=0/);
    assert.match(s.method, /n-1/);
  });
});

describe('samplingSensitivity', () => {
  it('reports the same curve at several intervals', () => {
    const rec = reconstructEquity([LONG], bars);
    const sens = samplingSensitivity(rec, bars, [45, 90]);
    assert.equal(sens.rows.length, 2);
    assert.equal(sens.rows[0].periods, 9);
    // Two bars per bucket, so roughly half the periods.
    assert.ok(sens.rows[1].periods < sens.rows[0].periods);
  });

  it('carries the un-annualised ratio alongside the annualised one', () => {
    const rec = reconstructEquity([LONG], bars);
    const row = samplingSensitivity(rec, bars, [45]).rows[0];
    assert.ok(row.sharpe_unannualised != null);
    assert.ok(Math.abs(row.sharpe) > Math.abs(row.sharpe_unannualised));
  });
});

describe('perTradeRatios', () => {
  it('computes on realised legs, so it is comparable to a trade-indexed curve', () => {
    const rec = reconstructEquity([LONG], bars);
    const p = perTradeRatios(rec.placed, bars);
    assert.equal(p.basis, 'per_closed_trade');
    assert.equal(p.periods, 1);
  });
});

describe('summariseExcursionPaths', () => {
  it('separates when winners and losers take their heat', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ net_profit: 10, mae_at: 0.02, mfe_at: 0.8, index: i })),
      ...Array.from({ length: 4 }, (_, i) => ({ net_profit: -5, mae_at: 1, mfe_at: 0.1, index: 10 + i })),
    ];
    const s = summariseExcursionPaths(rows);
    assert.equal(s.n, 9);
    assert.equal(s.mae_at.winners.first_quarter, 5);
    assert.equal(s.mae_at.winners.last_quarter, 0);
    assert.equal(s.mae_at.losers.last_quarter, 4);
    assert.equal(s.mae_at.losers.first_quarter, 0);
  });

  it('drops rows with no timing rather than counting them as zero', () => {
    const s = summariseExcursionPaths([{ net_profit: 1, mae_at: null, mfe_at: null }]);
    assert.equal(s.n, 0);
  });
});

describe('drawdownAndRunup', () => {
  it('reports both from the same series, in one pass', () => {
    // The two answers come from the same walk, which is the point: a run-up
    // from one basis against a drawdown from another is the error this module
    // found in TradingView own figures.
    const d = drawdownAndRunup([0, 5, 2, 9, 6]);
    assert.equal(d.drawdown, 3, 'peak 5 down to 2');
    // Run-up is measured from the running TROUGH, which is the 0 the series
    // opens at -- not from the 2 that immediately precedes the 9.
    assert.equal(d.runup, 9);
  });

  it('gives nulls for an empty series rather than zeros', () => {
    assert.deepEqual(drawdownAndRunup([]), { drawdown: null, runup: null });
  });
});

describe('intrabarEnvelope', () => {
  const rec = reconstructEquity([LONG], bars);

  it('is at least as wide as the close-mark curve', () => {
    const env = intrabarEnvelope(rec, bars);
    const close = drawdownAndRunup([0, ...rec.equity]);
    assert.ok(env.drawdown >= close.drawdown);
    assert.ok(env.runup >= close.runup);
  });

  it('marks the position at the bar extremes, not at the close', () => {
    // The envelope peaks at the bar 2 HIGH of 101 (+1), not at its close of
    // 100.5 (+0.5), and troughs at the bar 3 LOW of 98 (-2). The close-mark
    // curve can see neither, and reports 1.5 against this 3.
    const env = intrabarEnvelope(rec, bars);
    assert.equal(env.drawdown, 3, '+1 at the bar 2 high down to -2 at the bar 3 low');
    assert.equal(maxDrawdown(rec.equity, bars.times).max_drawdown, 1.5);
    assert.equal(env.basis, 'per_bar_intrabar_envelope');
  });
});

describe('closedTradeCurve', () => {
  it('carries no unrealised mark, so it cannot reach the intrabar extremes', () => {
    const rec = reconstructEquity([LONG], bars);
    const closed = closedTradeCurve(rec.placed);
    assert.equal(closed.basis, 'per_closed_trade');
    assert.equal(closed.legs, 1);
    // One leg realising 3.78: the curve is [0, 3.78] and never dips.
    assert.equal(closed.drawdown, 0);
    assert.equal(closed.runup, 3.78);
    // The same book marked per bar DOES dip, which is why the two bases must
    // never be quoted against one another.
    assert.ok(intrabarEnvelope(rec, bars).drawdown > closed.drawdown);
  });
});

describe('refineExcursions', () => {
  // Split each 45-second bar into three 15-second bars with the SAME extremes
  // spread across them. A finer series that contains the same prices must
  // return the same excursion: that is the identity measured live at 5S and
  // 1S, and this pins it.
  const fineRaw = [];
  for (const b of raw) {
    const [t, o, h, l, c] = b;
    fineRaw.push([t, o, h, o, o, 1]);
    fineRaw.push([t + 15, o, h, l, c, 1]);
    fineRaw.push([t + 30, c, c, l, c, 1]);
  }
  const fine = prepareBars(fineRaw);

  it('reproduces the coarse excursion exactly when the prices are the same', () => {
    const rec = reconstructEquity([LONG], bars);
    const coarse = excursionPaths(rec.placed, bars).rows[0];
    const ref = refineExcursions(rec.placed, fine, 45);
    assert.equal(ref.coverage.legs_refined, 1);
    assert.equal(ref.rows[0].mae_refined, coarse.mae_recomputed);
    assert.equal(ref.rows[0].mfe_refined, coarse.mfe_recomputed);
    assert.equal(ref.rows[0].mae_delta, 0, 'a bar high is the maximum of the highs inside it');
  });

  it('resolves the timing far more finely than the coarse series can', () => {
    const rec = reconstructEquity([LONG], bars);
    const ref = refineExcursions(rec.placed, fine, 45);
    // Three bars held at 45s becomes nine at 15s, so mae_at is no longer
    // quantised to thirds. This is the one thing finer bars actually buy.
    assert.equal(ref.rows[0].fine_bars_held, 9);
  });

  it('reports legs outside the finer window instead of dropping them', () => {
    const rec = reconstructEquity([LONG], bars);
    // A finer series covering only the tail cannot reach a leg entered at bar 2.
    const tail = prepareBars(fineRaw.slice(-6));
    const ref = refineExcursions(rec.placed, tail, 45);
    assert.equal(ref.coverage.legs_refined, 0);
    assert.equal(ref.coverage.legs_uncovered, 1);
    assert.deepEqual(ref.coverage.uncovered_trade_indexes, [0]);
  });
});

describe('tighteningBenefit', () => {
  const rec = reconstructEquity([LONG], bars);

  it('leaves a leg alone when it never reaches the arm level', () => {
    // LONG peaks at 3.89 of leg equity, so an arm of 10 never fires.
    const out = tighteningBenefit(rec.placed, bars, [10]);
    assert.equal(out.levels[0].legs_armed, 0);
    assert.equal(out.levels[0].delta_total, 0);
  });

  it('brackets intrabar ordering instead of assuming it', () => {
    const out = tighteningBenefit(rec.placed, bars, [1]);
    const pess = out.levels.find((l) => l.same_bar_can_stop);
    const opt = out.levels.find((l) => !l.same_bar_can_stop);
    assert.equal(out.levels.length, 2, 'both readings are always returned');
    // The pessimistic reading can only stop more legs, never fewer.
    assert.ok(pess.legs_stopped >= opt.legs_stopped);
  });

  it('charges the exit commission to the counterfactual exit', () => {
    // Arm 1 fires at bar 3 (equity reaches 1.89 on the bar 2 high of 101);
    // bar 3 then trades down to 98, through a floor of 0. The leg is stopped
    // at the floor less the exit-side commission rather than at the floor.
    const out = tighteningBenefit(rec.placed, bars, [1]);
    const pess = out.levels.find((l) => l.same_bar_can_stop);
    assert.equal(pess.legs_stopped, 1);
    assert.equal(pess.delta_from_winners, -3.89, 'a 3.78 winner becomes -0.11');
    assert.equal(pess.winners_hurt, 1);
  });

  it('states what it does not model', () => {
    const out = tighteningBenefit(rec.placed, bars, [1]);
    assert.equal(out.assumptions.length, 3);
    assert.match(out.assumptions.join(' '), /slippage/);
    assert.match(out.reading, /three trades a week/);
  });
});
