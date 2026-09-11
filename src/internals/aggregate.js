/**
 * Distributions computed from a normalised trade book.
 *
 * Why this exists: the raw book is ~77,000 characters pretty-printed, about
 * 19,000 tokens. A ten-window walk-forward returning full books costs 190,000
 * tokens and defeats the recipe it is supposed to serve. The agent almost
 * never needs 105 trade objects; it needs what is computed from them.
 *
 * So aggregation lives here, beside `reconcile()` in report.js, rather than in
 * whichever tool happened to need it first. Every consumer — `backtest_run`,
 * `walk_forward`, an ad-hoc read — derives these numbers once, by one method,
 * and two windows are therefore comparable by construction.
 *
 * Everything here is pure. Give it `trades` from `normaliseTrade` and it has
 * no other dependency.
 */

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);

const nums = (rows, pick) => rows.map(pick).filter((v) => v != null && Number.isFinite(v));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);

/**
 * Percentile by nearest-rank on the sorted sample.
 *
 * Stated rather than assumed, because a percentile is only comparable across
 * builds if everyone computes it the same way, and the interpolating and
 * nearest-rank conventions differ by enough at n=84 to move a stop level.
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))];
}

/** Shape of every distribution reported here. */
export function describe(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0 };
  const m = mean(v);
  const sd = v.length > 1 ? Math.sqrt(sum(v.map((x) => (x - m) ** 2)) / (v.length - 1)) : 0;
  return {
    n: v.length,
    mean: r2(m),
    sd: r2(sd),
    min: r2(Math.min(...v)),
    p25: r2(percentile(v, 0.25)),
    p50: r2(percentile(v, 0.5)),
    p75: r2(percentile(v, 0.75)),
    p90: r2(percentile(v, 0.9)),
    p95: r2(percentile(v, 0.95)),
    max: r2(Math.max(...v)),
  };
}

/**
 * Concentration: how much of the result rests on how few trades.
 *
 * The reason this is a first-class output and not an afterthought. On the
 * reference book, three of eighty-four base trades carried 75.7% of base net.
 * At that concentration most overlays are not being scored on their own merit
 * but on their proximity to a handful of observations, and a summary that
 * reports only mean and PF hides it completely.
 */
export function concentration(trades) {
  const wins = trades.filter((t) => t.net_profit > 0).sort((a, b) => b.net_profit - a.net_profit);
  const grossWin = sum(wins.map((t) => t.net_profit));
  const net = sum(nums(trades, (t) => t.net_profit));
  const share = (k) => {
    const top = wins.slice(0, k);
    return {
      k,
      pnl: r2(sum(top.map((t) => t.net_profit))),
      pct_of_gross_win: grossWin ? r4((100 * sum(top.map((t) => t.net_profit))) / grossWin) : null,
      pct_of_net: net ? r4((100 * sum(top.map((t) => t.net_profit))) / net) : null,
    };
  };
  const decile = Math.max(1, Math.ceil(wins.length / 10));
  return {
    winners: wins.length,
    gross_win: r2(grossWin),
    top_1: share(1),
    top_3: share(3),
    top_5: share(5),
    top_decile: share(decile),
    // Gini over winner P&L: 0 = every winner equal, 1 = one trade is the book.
    gini_winners: giniOf(wins.map((t) => t.net_profit)),
  };
}

function giniOf(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const total = sum(v);
  if (!total) return null;
  let acc = 0;
  for (let i = 0; i < v.length; i++) acc += (i + 1) * v[i];
  return r4((2 * acc) / (v.length * total) - (v.length + 1) / v.length);
}

/** Split a book by a tag token, e.g. 'ADD'. */
export function splitByToken(trades, token) {
  const has = (t) => (t.entry?.tag_tokens || []).includes(token);
  return { with: trades.filter(has), without: trades.filter((t) => !has(t)) };
}

/** Every entry-tag token present, with counts. Cheap vocabulary discovery. */
export function tagVocabulary(trades) {
  const out = {};
  for (const t of trades) for (const tk of t.entry?.tag_tokens || []) out[tk] = (out[tk] || 0) + 1;
  return out;
}

function pnlBlock(rows) {
  const p = nums(rows, (t) => t.net_profit);
  const wins = p.filter((x) => x > 0);
  const losses = p.filter((x) => x <= 0);
  const grossLoss = Math.abs(sum(losses));
  return {
    n: p.length,
    net: r2(sum(p)),
    wins: wins.length,
    losses: losses.length,
    win_rate: p.length ? r4(wins.length / p.length) : null,
    gross_win: r2(sum(wins)),
    gross_loss: r2(grossLoss),
    profit_factor: grossLoss ? r4(sum(wins) / grossLoss) : null,
    avg_win: r2(mean(wins)),
    avg_loss: r2(mean(losses)),
    expectancy: r2(mean(p)),
  };
}

/**
 * Counterfactual: what a fixed adverse-excursion stop at L would have produced.
 *
 * For each trade, if MAE >= L the trade is assumed stopped at exactly -L;
 * otherwise it keeps its actual net. Both simplifications are optimistic and
 * both are stated on the output so nobody has to rediscover them:
 *
 *   - `mae_understated`: MAE is read off bar extremes, so true intrabar MAE is
 *     >= reported MAE. The bias runs ONE WAY. Pass `factor` to scale it and
 *     see whether a level survives.
 *   - Slippage and the spread at the stop are not modelled, so a real stop
 *     fills worse than -L.
 *
 * `forfeit` and `saved` are reported separately because the net alone hides
 * which side of the ledger is moving: a level can gain on paper by capping
 * losers while cutting the few winners the edge is actually concentrated in.
 */
export function counterfactualStop(trades, levels, factor = 1) {
  const actual = sum(nums(trades, (t) => t.net_profit));
  return {
    factor,
    actual_net: r2(actual),
    mae_understated: 'true intrabar MAE >= reported MAE; bias is one-directional',
    slippage_modelled: false,
    levels: levels.map((L) => {
      let net = 0, winnersCut = 0, forfeit = 0, losersCapped = 0, saved = 0;
      const cutWinners = [];
      for (const t of trades) {
        const mae = (t.mae ?? 0) * factor;
        if (mae >= L) {
          net -= L;
          if (t.net_profit > 0) {
            winnersCut++;
            forfeit += t.net_profit + L;
            cutWinners.push({ index: t.index, net: r2(t.net_profit), mae: r2(t.mae) });
          } else {
            losersCapped++;
            saved += -t.net_profit - L;
          }
        } else net += t.net_profit;
      }
      cutWinners.sort((a, b) => b.net - a.net);
      return {
        level: L,
        net: r2(net),
        delta: r2(net - actual),
        winners_cut: winnersCut,
        winner_pnl_forfeited: r2(forfeit),
        losers_capped: losersCapped,
        loser_loss_saved: r2(saved),
        biggest_winners_cut: cutWinners.slice(0, 3),
      };
    }),
  };
}

/**
 * Headroom: how close the trades that carry the book sit to a candidate level.
 *
 * A level whose margin over the runners is smaller than the known measurement
 * bias is not a level, it is a coin toss. This reports the margin explicitly
 * rather than leaving it to be inferred from a counterfactual net.
 */
export function runnerHeadroom(trades, level, topK = 5) {
  const wins = trades.filter((t) => t.net_profit > 0).sort((a, b) => b.net_profit - a.net_profit);
  const net = sum(nums(trades, (t) => t.net_profit));
  const top = wins.slice(0, topK);
  const rows = top.map((t) => ({
    index: t.index,
    net: r2(t.net_profit),
    mae: r2(t.mae),
    bars_held: t.bars_held,
    tag: t.entry?.tag ?? null,
    headroom: t.mae == null ? null : r2(level - t.mae),
    // The MAE understatement that would put this trade past the level.
    flip_factor: t.mae ? r4(level / t.mae) : null,
  }));
  const survivors = rows.filter((x) => x.headroom != null && x.headroom > 0);
  return {
    level,
    top_k: topK,
    pct_of_net_in_top_k: net ? r4((100 * sum(top.map((t) => t.net_profit))) / net) : null,
    min_headroom: survivors.length ? r2(Math.min(...survivors.map((x) => x.headroom))) : null,
    // The smallest MAE understatement that cuts one of the top-k winners.
    min_flip_factor: survivors.length ? r4(Math.min(...survivors.map((x) => x.flip_factor))) : null,
    rows,
  };
}

/**
 * The default payload for a backtest read: a few KB instead of ~77 KB.
 *
 * @param {object[]} trades       normalised trades
 * @param {object}   [opts]
 * @param {string[]} [opts.splitTokens]  entry-tag tokens to split on
 * @param {number[]} [opts.stopLevels]   candidate stop levels; omit to skip
 * @param {number[]} [opts.stopFactors]  MAE scale factors for sensitivity
 */
export function aggregateTrades(trades, {
  splitTokens = ['ADD'],
  stopLevels = null,
  stopFactors = [1, 1.05, 1.1, 1.2],
} = {}) {
  // An open position's row is mark-to-market: its net, MAE and MFE change on
  // every tick. Measured at the live edge, one row's net moved 16.78 -> 19.20
  // between two reads seconds apart. A moving number does not belong in a
  // distribution, so it is excluded and the exclusion is reported rather than
  // silently applied.
  const supplied = trades || [];
  const rows = supplied.filter((t) => !t.is_open);
  const openExcluded = supplied.length - rows.length;
  const wins = rows.filter((t) => t.net_profit > 0);
  const losses = rows.filter((t) => t.net_profit <= 0);

  const out = {
    closed_trades: rows.length,
    ...(openExcluded
      ? {
          open_rows_excluded: openExcluded,
          open_rows_note: 'Open positions are mark-to-market and were excluded from every figure below.',
        }
      : {}),
    pnl: pnlBlock(rows),
    mae: {
      all: describe(nums(rows, (t) => t.mae)),
      winners: describe(nums(wins, (t) => t.mae)),
      losers: describe(nums(losses, (t) => t.mae)),
      // The separation question in one number: a stop can only work if
      // winners' excursions sit below losers'.
      winner_p95_vs_loser_mean: {
        winner_p95: r2(percentile(nums(wins, (t) => t.mae), 0.95)),
        loser_mean: r2(mean(nums(losses, (t) => t.mae))),
        separated:
          nums(wins, (t) => t.mae).length && nums(losses, (t) => t.mae).length
            ? percentile(nums(wins, (t) => t.mae), 0.95) < mean(nums(losses, (t) => t.mae))
            : null,
      },
    },
    mfe: { all: describe(nums(rows, (t) => t.mfe)), winners: describe(nums(wins, (t) => t.mfe)) },
    bars_held: { all: describe(nums(rows, (t) => t.bars_held)), winners: describe(nums(wins, (t) => t.bars_held)) },
    concentration: concentration(rows),
    tags: tagVocabulary(rows),
    direction: {
      long: pnlBlock(rows.filter((t) => t.direction === 'long')),
      short: pnlBlock(rows.filter((t) => t.direction === 'short')),
    },
    splits: {},
  };

  for (const token of splitTokens) {
    const { with: withTok, without } = splitByToken(rows, token);
    if (!withTok.length) continue;
    out.splits[token] = {
      with: { pnl: pnlBlock(withTok), mae: describe(nums(withTok, (t) => t.mae)) },
      without: { pnl: pnlBlock(without), mae: describe(nums(without, (t) => t.mae)) },
      without_winner_mae_p95: r2(percentile(nums(without.filter((t) => t.net_profit > 0), (t) => t.mae), 0.95)),
      without_loser_mae_mean: r2(mean(nums(without.filter((t) => t.net_profit <= 0), (t) => t.mae))),
    };
  }

  if (stopLevels && stopLevels.length) {
    out.stop_counterfactual = {
      base: counterfactualStop(rows, stopLevels),
      sensitivity: stopFactors.map((f) => ({
        factor: f,
        deltas: counterfactualStop(rows, stopLevels, f).levels.map((l) => ({
          level: l.level,
          delta: l.delta,
        })),
      })),
    };
  }
  return out;
}
