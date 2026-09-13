/**
 * Phase 0.7 Task 1 — compare two strategy trade books over a time window. Offline.
 *
 *   node recon/book-compare.mjs <a.json> <a-trades-field> <b.json> <b-trades-field> <from sec> <to sec>
 *
 * A trade is identified by entry time + entry comment + entry price + exit time
 * + exit price. Only trades whose ENTRY and EXIT both fall inside [from, to] are
 * compared, so a trade still open at the window edge is not called a mismatch.
 */
import { readFileSync } from 'node:fs';
const [aPath, aField, bPath, bField, fromS, toS] = process.argv.slice(2);
const pick = (o, f) => f.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const A = pick(JSON.parse(readFileSync(aPath, 'utf8')), aField) || [];
const B = pick(JSON.parse(readFileSync(bPath, 'utf8')), bField) || [];
const from = Number(fromS) * 1000; const to = Number(toS) * 1000;
const inWin = (t) => t.e.tm >= from && t.x && t.x.tm && t.x.tm <= to;
const key = (t) => `${t.e.tm}|${t.e.c}|${t.e.p}|${t.x.tm}|${t.x.p}`;
const entryKey = (t) => `${t.e.tm}|${t.e.c}|${t.e.p}`;
const a = A.filter(inWin); const b = B.filter(inWin);
const bk = new Set(b.map(key)); const ak = new Set(a.map(key));
const be = new Map(b.map((t) => [entryKey(t), t]));
const onlyA = a.filter((t) => !bk.has(key(t)));
const onlyB = b.filter((t) => !ak.has(key(t)));
const sameEntryDiffExit = onlyA.filter((t) => be.has(entryKey(t))).map((t) => ({ entry: entryKey(t), a_exit: [t.x.tm, t.x.p, t.x.c], b_exit: [be.get(entryKey(t)).x.tm, be.get(entryKey(t)).x.p, be.get(entryKey(t)).x.c] }));
const pnl = (xs) => +xs.reduce((s, t) => s + (t.pf?.v ?? t.pf ?? 0), 0).toFixed(2);
const fmt = (t) => `${new Date(t.e.tm).toISOString().slice(5, 19)} ${t.e.c}@${t.e.p} -> ${new Date(t.x.tm).toISOString().slice(5, 19)}@${t.x.p}`;
console.log(JSON.stringify({
  window: [new Date(from).toISOString(), new Date(to).toISOString()],
  a_trades: a.length, b_trades: b.length, identical: a.length - onlyA.length,
  only_in_a: onlyA.length, only_in_b: onlyB.length, same_entry_different_exit: sameEntryDiffExit.length,
  first_divergence: [...onlyA, ...onlyB].sort((x, y) => x.e.tm - y.e.tm)[0] ? fmt([...onlyA, ...onlyB].sort((x, y) => x.e.tm - y.e.tm)[0]) : null,
  examples_only_a: onlyA.slice(0, 4).map(fmt), examples_only_b: onlyB.slice(0, 4).map(fmt), same_entry_different_exit_examples: sameEntryDiffExit.slice(0, 3),
  pf_sample: a[0] ? a[0].pf : null,
}, null, 1));
