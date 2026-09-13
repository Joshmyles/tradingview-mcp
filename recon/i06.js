/**
 * Phase 0.6 Task 5 — bar INTEGRITY at depth, not merely bar arrival.
 *
 * Phase 0.5 established that bars arrive back to 2023-12-19T07:42:30Z. Arrival
 * is not integrity. 45S is a custom interval TradingView constructs from
 * seconds data, and seconds history is normally far shallower than 21 months,
 * so the hypothesis to kill is that deep "45s" bars are derived or upsampled
 * from a coarser series.
 *
 * WHAT WOULD BETRAY AN UPSAMPLED BAR, and why each is measured:
 *   grid        real 45s bars sit on a 45s lattice. A series resampled from 1m
 *               cannot land every bar on that lattice without inventing edges.
 *   flat bars   splitting one coarse bar into several leaves bars with no
 *               internal range (h == l) or no body (o == c) far more often than
 *               a genuine series does.
 *   range       an upsample divides one bar's range among its children, so the
 *               range distribution shifts down and tightens.
 *   volume      a divided volume shows as suspiciously uniform or integer-split
 *               values; a synthesised one often shows as zero.
 *   repeats     consecutive bars with identical OHLC are the signature of a
 *               forward-filled gap.
 *
 * Sequential and unhurried: one selectDate per window, through the Task 4 lock.
 */
import { start } from '../src/core/replay.js';
import { evaluate } from '../src/connection.js';

const READ_BARS_JS = `
(function () {
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    var ms = cw._chartWidget.model().model().mainSeries();
    var b = ms.bars();
    var out = [];
    for (var i = b.firstIndex(); i <= b.lastIndex(); i++) {
      var v = b.valueAt(i);
      if (!v) continue;
      out.push([v[0], v[1], v[2], v[3], v[4], v[5]]);
    }
    return JSON.stringify({ ok: true, interval: String(ms.interval()), symbol: String(ms.symbol()), bars: out });
  } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
})()`;

function analyse(label, date, payload) {
  const bars = payload.bars
    .map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }))
    .filter((b) => [b.t, b.o, b.h, b.l, b.c].every((x) => typeof x === 'number' && Number.isFinite(x)))
    .sort((a, b) => a.t - b.t);

  const n = bars.length;
  if (n < 5) return { label, date, n, error: 'too few bars to analyse' };

  // ---- timestamp grid. TradingView bar times are epoch SECONDS here.
  const deltas = [];
  for (let i = 1; i < n; i++) deltas.push(bars[i].t - bars[i - 1].t);
  const deltaCounts = {};
  for (const d of deltas) deltaCounts[d] = (deltaCounts[d] || 0) + 1;
  const onGrid = bars.filter((b) => b.t % 45 === 0).length;

  // ---- shape of the bars
  const ranges = bars.map((b) => b.h - b.l);
  const sorted = [...ranges].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  const flatRange = bars.filter((b) => b.h === b.l).length;
  const flatBody = bars.filter((b) => b.o === b.c).length;
  let repeats = 0;
  for (let i = 1; i < n; i++) {
    const a = bars[i - 1]; const b = bars[i];
    if (a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c) repeats++;
  }

  // ---- volume
  const vols = bars.map((b) => (typeof b.v === 'number' && Number.isFinite(b.v) ? b.v : null)).filter((x) => x !== null);
  const zeroVol = vols.filter((x) => x === 0).length;
  const vSorted = [...vols].sort((a, b) => a - b);
  const vq = (p) => (vSorted.length ? vSorted[Math.floor(p * (vSorted.length - 1))] : null);
  const distinctVols = new Set(vols).size;

  return {
    label,
    date,
    n,
    span_utc: [new Date(bars[0].t * 1000).toISOString(), new Date(bars[n - 1].t * 1000).toISOString()],
    grid: {
      delta_histogram: deltaCounts,
      modal_delta_sec: Number(Object.entries(deltaCounts).sort((a, b) => b[1] - a[1])[0][0]),
      pct_delta_45: +(100 * (deltas.filter((d) => d === 45).length / deltas.length)).toFixed(2),
      pct_on_45s_boundary: +(100 * (onGrid / n)).toFixed(2),
    },
    shape: {
      range_min: +q(0).toFixed(4),
      range_p25: +q(0.25).toFixed(4),
      range_median: +q(0.5).toFixed(4),
      range_p75: +q(0.75).toFixed(4),
      range_max: +q(1).toFixed(4),
      pct_zero_range: +(100 * (flatRange / n)).toFixed(2),
      pct_zero_body: +(100 * (flatBody / n)).toFixed(2),
      pct_repeat_ohlc: +(100 * (repeats / (n - 1))).toFixed(2),
    },
    volume: {
      count: vols.length,
      pct_zero: vols.length ? +(100 * (zeroVol / vols.length)).toFixed(2) : null,
      median: vq(0.5),
      p25: vq(0.25),
      p75: vq(0.75),
      distinct_values: distinctVols,
      pct_distinct: vols.length ? +(100 * (distinctVols / vols.length)).toFixed(2) : null,
    },
  };
}

const WINDOWS = [
  ['deep_floor', '2023-12-20'],
  ['deep_plus_1w', '2023-12-27'],
  ['mid_2024', '2024-06-03'],
  ['mid_2025', '2025-06-02'],
  ['recent_2026_05', '2026-05-01'],
  ['recent_now', '2026-09-01'],
];

const results = [];
for (const [label, date] of WINDOWS) {
  process.stderr.write(`[sampling] ${label} @ ${date}\n`);
  try {
    await start({ date });
    // Let the series settle; bars stream in after selectDate resolves.
    await new Promise((r) => setTimeout(r, 4000));
    const raw = await evaluate(READ_BARS_JS);
    const payload = JSON.parse(raw);
    if (!payload.ok) { results.push({ label, date, error: payload.error }); continue; }
    results.push(analyse(label, date, payload));
  } catch (err) {
    results.push({ label, date, error: err.message });
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(JSON.stringify({ at: new Date().toISOString(), windows: results }, null, 2));
process.exit(0);
