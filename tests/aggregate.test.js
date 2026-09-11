/**
 * Aggregation and the deep-report normaliser.
 *
 * Pure functions, so no live chart. They are worth pinning because every
 * backtest answer is computed through them, and because a walk-forward is only
 * comparable across windows if the arithmetic is identical in each.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTrades,
  concentration,
  counterfactualStop,
  describe as stats,
  percentile,
  runnerHeadroom,
  splitByToken,
  tagVocabulary,
} from '../src/internals/aggregate.js';
import { normaliseDeepOrder, normaliseDeepTrade } from '../src/internals/deepbt.js';

const trade = (o) => ({
  index: o.index ?? 0,
  direction: o.direction ?? 'long',
  entry: { tag: o.tag ?? 'B', tag_tokens: (o.tag ?? 'B').split(' '), price: 100, time: 0, bar: 0 },
  exit: { tag: 'X', tag_tokens: ['X'], price: 101, time: 1, bar: o.bars ?? 10 },
  net_profit: o.net,
  mae: o.mae,
  mfe: o.mfe ?? Math.abs(o.net) * 2,
  bars_held: o.bars ?? 10,
});

// The three trades that carry the reference book, plus filler.
const RUNNERS = [
  trade({ index: 0, net: 60.56, mae: 4.68, bars: 422, tag: 'B CZX OPP UP' }),
  trade({ index: 1, net: 47.49, mae: 4.75, bars: 484, tag: 'B CZX OPP DN' }),
  trade({ index: 2, net: 27.03, mae: 4.68, bars: 834, tag: 'B CZX DN' }),
];
const LOSERS = Array.from({ length: 6 }, (_, i) =>
  trade({ index: 10 + i, net: -7, mae: 7.5, bars: 20 }),
);
const BOOK = [...RUNNERS, ...LOSERS];

describe('percentile', () => {
  it('is nearest-rank, not interpolated', () => {
    // Stated because a stop level derived at n=84 moves between conventions.
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    // floor((n-1)*p): at n=4 the 95th percentile is the THIRD value, not the
    // largest. Surprising, and exactly why the convention is written down --
    // a small sample's upper tail is not the max under this rule.
    assert.equal(percentile([1, 2, 3, 4], 0.95), 3);
    assert.equal(percentile([1, 2, 3, 4], 1), 4);
    assert.equal(percentile([], 0.5), null);
  });
});

describe('describe', () => {
  it('reports a sample sd, not a population sd', () => {
    const d = stats([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(d.n, 8);
    assert.equal(d.mean, 5);
    assert.equal(d.sd, 2.14); // n-1 denominator; the population value is 2
  });

  it('survives an empty or all-null sample without throwing', () => {
    assert.deepEqual(stats([]), { n: 0 });
    assert.deepEqual(stats([null, undefined, NaN]), { n: 0 });
  });
});

describe('concentration', () => {
  it('reports how few trades carry the book', () => {
    const c = concentration(BOOK);
    assert.equal(c.winners, 3);
    assert.equal(c.gross_win, 135.08);
    assert.equal(c.top_3.pnl, 135.08);
    assert.equal(c.top_3.pct_of_gross_win, 100);
    // 135.08 of a net of 135.08 - 42 = 93.08
    assert.equal(c.top_3.pct_of_net, 145.1225);
  });

  it('gives no gini for a single winner rather than a fake 0', () => {
    assert.equal(concentration([trade({ net: 5, mae: 1 })]).gini_winners, null);
  });
});

describe('counterfactualStop', () => {
  it('separates what a level forfeits from what it saves', () => {
    const { levels } = counterfactualStop(BOOK, [5]);
    const l = levels[0];
    // Every loser has MAE 7.5 >= 5, so all six cap at -5 instead of -7.
    assert.equal(l.losers_capped, 6);
    assert.equal(l.loser_loss_saved, 12);
    // No runner has MAE >= 5, so none is cut.
    assert.equal(l.winners_cut, 0);
    assert.equal(l.delta, 12);
  });

  it('names the biggest winners a level would cut', () => {
    const { levels } = counterfactualStop(BOOK, [4.7]);
    const l = levels[0];
    assert.equal(l.winners_cut, 1, 'only the MAE 4.75 runner crosses 4.7');
    assert.equal(l.biggest_winners_cut[0].net, 47.49);
  });

  it('a 5.3% MAE understatement cuts a runner that 1.00x cleared', () => {
    // The reference finding in one assertion: the level is not clearing the
    // runners by any margin worth the name.
    assert.equal(counterfactualStop(BOOK, [5], 1.0).levels[0].winners_cut, 0);
    assert.equal(counterfactualStop(BOOK, [5], 1.06).levels[0].winners_cut, 1);
  });

  it('states the two optimistic assumptions on the output', () => {
    const c = counterfactualStop(BOOK, [5]);
    assert.equal(c.slippage_modelled, false);
    assert.match(c.mae_understated, /one-directional/);
  });
});

describe('runnerHeadroom', () => {
  it('reports the margin and the factor that closes it', () => {
    const h = runnerHeadroom(BOOK, 5, 3);
    assert.equal(h.min_headroom, 0.25);
    assert.equal(h.min_flip_factor, 1.0526);
    assert.equal(h.rows[0].bars_held, 422);
  });
});

describe('splitByToken / tagVocabulary', () => {
  it('splits on an entry-tag token', () => {
    const book = [...BOOK, trade({ index: 99, net: 3, mae: 1, tag: 'B ADD UP' })];
    const { with: w, without } = splitByToken(book, 'ADD');
    assert.equal(w.length, 1);
    assert.equal(without.length, BOOK.length);
  });

  it('counts every token present', () => {
    const v = tagVocabulary(RUNNERS);
    assert.equal(v.CZX, 3);
    assert.equal(v.OPP, 2);
  });
});

describe('aggregateTrades', () => {
  it('answers the separation question directly', () => {
    const a = aggregateTrades(BOOK, { splitTokens: [] });
    const s = a.mae.winner_p95_vs_loser_mean;
    // Three winners with MAE [4.68, 4.68, 4.75]: p95 lands on index 1.
    assert.equal(s.winner_p95, 4.68);
    assert.equal(s.loser_mean, 7.5);
    assert.equal(s.separated, true);
  });

  it('is small enough to return by default', () => {
    const big = Array.from({ length: 105 }, (_, i) =>
      trade({ index: i, net: i % 3 ? 5 : -4, mae: 3 + (i % 7), bars: 10 + i }),
    );
    const chars = JSON.stringify(aggregateTrades(big, { stopLevels: [4, 5, 6] }), null, 2).length;
    assert.ok(chars < 20000, `aggregate is ${chars} chars; the point is to be far under the book's ~77k`);
  });

  it('omits the counterfactual unless levels are asked for', () => {
    assert.equal(aggregateTrades(BOOK).stop_counterfactual, undefined);
    assert.ok(aggregateTrades(BOOK, { stopLevels: [5] }).stop_counterfactual);
  });

  it('does not throw on an empty book', () => {
    const a = aggregateTrades([], { stopLevels: [5] });
    assert.equal(a.pnl.n, 0);
    assert.equal(a.mae.all.n, 0);
  });
});

describe('deep report normalisers', () => {
  // Shape measured on Desktop 3.4.1, 2026-09-10.
  const DEEP = {
    entry: { id: 'B CZX UP', price: 4640.01, time: 1787628810000, type: 'le', barIndex: 10 },
    exit: { id: 'B CZX HS', price: 4629.95, time: 1787631960000, type: 'lx', barIndex: 354 },
    profit: { value: -10.28, percentValue: -0.00221546 },
    cumulativeProfit: { value: -10.28, percentValue: -0.1028 },
    drawdown: { value: 10.17, percentValue: 0.0021917536 },
    runup: { value: 1.22, percentValue: 0.00026292424 },
    quantity: 1,
    tradeNumber: 1,
    commission: 0.22,
  };

  it('maps a deep trade onto the on-chart output shape', () => {
    const t = normaliseDeepTrade(DEEP, 0);
    assert.equal(t.direction, 'long');
    assert.equal(t.entry.tag, 'B CZX UP');
    assert.deepEqual(t.entry.tag_tokens, ['B', 'CZX', 'UP']);
    assert.equal(t.net_profit, -10.28);
    assert.equal(t.mae, 10.17, 'drawdown is MAE');
    assert.equal(t.mfe, 1.22, 'runup is MFE');
    assert.equal(t.bars_held, 344);
    assert.equal(t.source, 'deep_backtest');
  });

  it('reads direction from entry.type, which is the only place it is', () => {
    const short = normaliseDeepTrade({ ...DEEP, entry: { ...DEEP.entry, type: 'se' } }, 0);
    assert.equal(short.direction, 'short');
    // Gross flips sign with direction: a lower exit is a short's profit.
    assert.ok(short.gross_profit > 0);
    assert.ok(normaliseDeepTrade(DEEP, 0).gross_profit < 0);
  });

  it('survives an open trade with no exit', () => {
    const open = normaliseDeepTrade({ ...DEEP, exit: undefined }, 3);
    assert.equal(open.exit, null);
    assert.equal(open.bars_held, null);
    assert.equal(open.gross_profit, null);
  });

  it('maps a deep filled order', () => {
    const o = normaliseDeepOrder(
      { isBuy: true, comment: 'B CZX UP', isEntry: true, id: 'CZL', price: 4640.01, quantity: 1, barTime: 10, type: 'MARKET' },
      0,
    );
    assert.equal(o.side, 'buy');
    assert.equal(o.is_entry, true);
    assert.equal(o.tag, 'B CZX UP');
  });
});

describe('open positions', () => {
  it('are excluded from every figure, and the exclusion is reported', () => {
    // Measured at the live edge: TradingView synthesises a mark-to-market exit
    // for the open row, so it looks closed and its net moves on every tick.
    const open = { ...trade({ index: 99, net: 19.2, mae: 0.4, bars: 46 }), is_open: true };
    const a = aggregateTrades([...BOOK, open], { splitTokens: [] });
    assert.equal(a.closed_trades, BOOK.length);
    assert.equal(a.open_rows_excluded, 1);
    assert.equal(a.pnl.n, BOOK.length);
    assert.equal(a.concentration.winners, 3, 'the open row must not become a fourth winner');
  });

  it('says nothing when there is no open row', () => {
    const a = aggregateTrades(BOOK, { splitTokens: [] });
    assert.equal(a.open_rows_excluded, undefined);
    assert.equal(a.closed_trades, BOOK.length);
  });
});
