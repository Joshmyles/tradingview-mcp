/**
 * Phase 0.7 Task 1 — compare study rows from a replay run against a reference.
 *
 * Offline: reads JSON, touches no chart.
 *
 *   node recon/warmup-compare.mjs <ref.json> <ref-rows-field> <test.json> <test-rows-field> <T sec> [out]
 *
 * Rows are [time, plot_0 .. plot_n] as TradingView's study data() yields them.
 * Rows are matched by bar TIME, never by index (indices differ between surfaces).
 *
 * Per plot it reports, over bars at or after T:
 *   k_star        bars after T from which the plot agrees AND keeps agreeing to
 *                 the end of the compared range (0 = agreed from the first bar;
 *                 null = still disagreeing at the last compared bar)
 *   mismatches    split into:
 *                   na_vs_value     replay na, reference has a number  (safe: visible)
 *                   wrong_number    both numbers, different            (DANGEROUS)
 *                   value_vs_na     replay has a number, reference na  (DANGEROUS)
 * and separately the same counts for served history rows before T.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [refPath, refField, testPath, testField, Targ, outPath] = process.argv.slice(2);
const T = Number(Targ);
const pick = (obj, field) => field.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const refDoc = JSON.parse(readFileSync(refPath, 'utf8'));
const testDoc = JSON.parse(readFileSync(testPath, 'utf8'));
const ref = pick(refDoc, refField);
const test = pick(testDoc, testField);
const plots = refDoc.plots || null;

export const same = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
};

const refByT = new Map(ref.map((r) => [r[0], r]));
const nPlots = Math.max(...ref.slice(0, 50).map((r) => r.length)) - 1;

const blank = () => ({ na_vs_value: 0, wrong_number: 0, value_vs_na: 0 });
const per = Array.from({ length: nPlots }, (_, p) => ({
  plot: p, id: plots?.[p]?.id, type: plots?.[p]?.type, title: plots?.[p]?.title,
  after_T: blank(), before_T: blank(), last_bad_k: -1, max_abs_diff: 0, first_bad: null,
}));

const compared = test.filter((r) => refByT.has(r[0])).sort((a, b) => a[0] - b[0]);
const missingInRef = test.length - compared.length;
let k = -1; let bars_after_T = 0; let rows_before_T = 0;
const allBadRowsAfterT = [];
for (const tr of compared) {
  const rr = refByT.get(tr[0]);
  const after = tr[0] >= T;
  if (after) { k++; bars_after_T++; } else rows_before_T++;
  let rowBad = false;
  for (let p = 0; p < nPlots; p++) {
    const a = tr[p + 1] ?? null; const b = rr[p + 1] ?? null;
    if (same(a, b)) continue;
    rowBad = true;
    const bucket = after ? per[p].after_T : per[p].before_T;
    if (a === null) bucket.na_vs_value++;
    else if (b === null) bucket.value_vs_na++;
    else { bucket.wrong_number++; per[p].max_abs_diff = Math.max(per[p].max_abs_diff, Math.abs(a - b)); }
    if (after) {
      per[p].last_bad_k = k;
      if (!per[p].first_bad) per[p].first_bad = { k, t: tr[0], replay: a, reference: b };
    }
  }
  if (after && rowBad) allBadRowsAfterT.push(k);
}

const lastK = k;
const summary = per.map((x) => ({
  ...x,
  k_star: x.last_bad_k < 0 ? 0 : (x.last_bad_k >= lastK ? null : x.last_bad_k + 1),
}));
const disagreeing = summary.filter((x) => x.k_star !== 0);
// The binding plot is the slowest: never-converged (null) outranks any finite k*.
const rank = (x) => (x.k_star === null ? Infinity : x.k_star);
const binding = disagreeing.length ? disagreeing.reduce((m, x) => (rank(x) > rank(m) ? x : m)) : null;

const out = {
  T, t_iso: new Date(T * 1000).toISOString(),
  test_rows: test.length, compared_rows: compared.length, test_rows_not_in_reference: missingInRef,
  rows_before_T: rows_before_T, bars_after_T, last_k: lastK,
  overall: {
    rows_after_T_with_any_mismatch: allBadRowsAfterT.length,
    overall_k_star: allBadRowsAfterT.length === 0 ? 0 : (allBadRowsAfterT.at(-1) >= lastK ? null : allBadRowsAfterT.at(-1) + 1),
    plots_agreeing_from_k0: summary.filter((x) => x.k_star === 0).length,
    plots_total: nPlots,
    binding_plot: binding ? { plot: binding.plot, title: binding.title, k_star: binding.k_star } : null,
    dangerous_after_T: summary.reduce((s, x) => s + x.after_T.wrong_number + x.after_T.value_vs_na, 0),
    visible_na_after_T: summary.reduce((s, x) => s + x.after_T.na_vs_value, 0),
    mismatches_before_T: summary.reduce((s, x) => s + x.before_T.na_vs_value + x.before_T.wrong_number + x.before_T.value_vs_na, 0),
  },
  disagreeing_plots: disagreeing.map(({ last_bad_k, ...rest }) => rest),
};
if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
