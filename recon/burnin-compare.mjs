/**
 * Phase 0.7 Task 1 — how long after a compute start do two trade books agree?
 * Offline.
 *
 * Replay computes the strategy over a rolling window that starts ~20k bars
 * before the replay START (`dateRange.backtest.from`, fixed for the session).
 * Two sessions whose compute starts differ are the same program run from
 * different first bars. Over their overlap, any trade that differs is start-
 * dependence; the time after the LATER compute start beyond which every trade
 * agrees is the burn-in a deep-replay book needs.
 *
 *   node recon/burnin-compare.mjs <base.json> <other.json> [<other.json> ...]
 *
 * Each file is a j03 dump. Trades are read from end_dump (falling back to
 * start_dump). The overlap is [later compute start, earlier session end].
 */
import { readFileSync } from 'node:fs';

const load = (p) => {
  const d = JSON.parse(readFileSync(p, 'utf8'));
  // j03 session dumps nest under end_dump/start_dump; the j01 chart reference is flat.
  const dump = d.end_dump || d.start_dump || d;
  return {
    path: p,
    compute_from: dump.date_range.backtest.from,
    end: dump.date_range.backtest.to,
    trades: dump.trades || [],
  };
};
const key = (t) => `${t.e.tm}|${t.e.c}|${t.e.p}|${t.x.tm}|${t.x.p}|${t.x.c}`;
const hours = (ms) => +(ms / 3.6e6).toFixed(2);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

const [basePath, ...others] = process.argv.slice(2);
const base = load(basePath);
const out = [];
for (const p of others) {
  const o = load(p);
  const from = Math.max(base.compute_from, o.compute_from);
  const to = Math.min(base.end, o.end);
  const inWin = (t) => t.e.tm >= from && t.x && t.x.tm && t.x.tm <= to;
  const a = base.trades.filter(inWin); const b = o.trades.filter(inWin);
  const ak = new Set(a.map(key)); const bk = new Set(b.map(key));
  const diff = [...a.filter((t) => !bk.has(key(t))), ...b.filter((t) => !ak.has(key(t)))]
    .sort((x, y) => x.e.tm - y.e.tm);
  const lastDiff = diff.at(-1);
  const agreeing = a.filter((t) => bk.has(key(t)));
  const firstAgreeAfterLastDiff = lastDiff ? a.find((t) => t.e.tm > lastDiff.e.tm && bk.has(key(t))) : a[0];
  out.push({
    other: p,
    compute_starts: { base: iso(base.compute_from), other: iso(o.compute_from), apart_hours: hours(Math.abs(base.compute_from - o.compute_from)) },
    overlap: { from: iso(from), to: iso(to), hours: hours(to - from) },
    trades_in_overlap: { base: a.length, other: b.length, identical: agreeing.length, differing_rows: diff.length },
    differences: diff.map((t) => ({
      at: iso(t.e.tm), hours_after_later_compute_start: hours(t.e.tm - from),
      side: ak.has(key(t)) ? 'base_only' : 'other_only', entry: `${t.e.c}@${t.e.p}`, exit: `${t.x.c}@${t.x.p} ${iso(t.x.tm)}`,
    })),
    burn_in_hours: lastDiff ? hours(lastDiff.x.tm - from) : 0,
    note: lastDiff
      ? `every trade entered after ${iso(lastDiff.x.tm)} agrees (first such: ${firstAgreeAfterLastDiff ? iso(firstAgreeAfterLastDiff.e.tm) : 'none in overlap'})`
      : 'all trades in the overlap agree',
  });
}
console.log(JSON.stringify(out, null, 1));
