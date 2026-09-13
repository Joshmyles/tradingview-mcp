/**
 * Parse `input.*` declarations out of Pine source.
 *
 * WHY THIS EXISTS
 * ---------------
 * A build's reference manifest must be derived from the build's own source plus
 * an explicit override list - never from a snapshot of a chart. The chart is
 * the thing being checked; deriving the reference from it makes the check
 * vacuous, and it is exactly how an unintended configuration became the
 * baseline in the first place (`in_323` on against a `defval` of false, with
 * every recorded figure describing it).
 *
 * WHAT `in_N` IS
 * --------------
 * TradingView numbers inputs by the order their `input.*` calls appear, from
 * zero. Nothing in the source says `in_0`; the index IS the position. That
 * makes the numbering fragile in a way worth stating: deleting one input
 * renumbers every input after it, so a manifest written against one revision
 * of a script silently means something else against the next. It has already
 * happened once in this lineage - five dead inputs removed from build 13
 * shifted the whole tail.
 *
 * This is why the parse is verified against the live `metaInfo().inputs` by
 * NAME before a manifest built from it is trusted: names are the independent
 * evidence that the positional mapping is the one TradingView made.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * A default that is an expression - `color.new(color.blue, 70)` - has no value
 * until the script is compiled. Those are reported with `default_literal:
 * false` and no value, and a manifest built from this source leaves them
 * unpinned rather than guessing. Every input that decides a trade carries a
 * literal default; the unevaluable ones are colours.
 */
import { answered, failed } from './verdict.js';

/** Input constructors. Longest alternatives first so `int` cannot win inside `integer`-like names. */
const INPUT_CALL =
  /\binput(?:\.(text_area|timeframe|resolution|session|source|string|symbol|price|color|float|bool|time|enum|int))?\s*\(/g;

/**
 * Split a call's argument list at top-level commas.
 *
 * Hand-rolled because the arguments nest - `color.new(color.blue, 70)` - and
 * carry strings containing both quote styles and commas. Pine has no template
 * literals and no regex literals, so tracking quotes and depth is sufficient.
 */
function splitArgs(src, openIndex) {
  const args = [];
  let depth = 0;
  let start = openIndex + 1;
  let quote = null;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') { depth++; continue; }
    if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return { args, end: i };
      }
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null; // unterminated call
}

/** `name = value` if the argument is a named one, else null. */
function namedArg(arg) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*([\s\S]*)$/.exec(arg);
  return m ? { name: m[1], value: m[2].trim() } : null;
}

/**
 * A literal value, or `{ literal: false }` for anything needing compilation.
 *
 * Deliberately narrow. `100 * 2` is arithmetic a parser could fold and a reader
 * could not audit at a glance, so it is left unevaluated like any other
 * expression: the point of this file is a manifest somebody can check by eye
 * against the source.
 */
function literalValue(expr) {
  const s = expr.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(s) || /^'(?:[^'\\]|\\.)*'$/.test(s)) {
    return { literal: true, value: s.slice(1, -1).replace(/\\(.)/g, '$1') };
  }
  if (s === 'true' || s === 'false') return { literal: true, value: s === 'true' };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return { literal: true, value: Number(s) };
  return { literal: false, expr: s };
}

/**
 * Blank out comments and string contents so a scan cannot match inside either.
 *
 * Replaced with spaces of the same length, so every index into the result still
 * points at the same character of the original source.
 */
export function maskSource(src) {
  const out = src.split('');
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { out[i] = ' '; out[i + 1] = ' '; i++; continue; }
      if (c === quote) quote = null;
      else out[i] = ' ';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; }
      i--;
      continue;
    }
  }
  return out.join('');
}

/**
 * Every `input.*` declaration in source order.
 *
 * Returns `[{ id, index, kind, title, group, default, default_literal,
 * default_expr, line }]`, where `id` is `in_<index>` and the index IS the
 * position - see the header.
 */
export function parseInputDeclarations(source) {
  const masked = maskSource(source);
  const decls = [];
  INPUT_CALL.lastIndex = 0;
  let m;
  while ((m = INPUT_CALL.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const split = splitArgs(source, open);
    if (!split) continue;
    // A bare `input(...)` infers its type from the default; keep it distinct
    // from a typed call rather than guessing which type it became.
    const kind = m[1] || 'auto';
    const positional = [];
    const named = {};
    for (const arg of split.args) {
      const n = namedArg(arg);
      if (n) named[n.name] = n.value;
      else positional.push(arg);
    }
    const defvalExpr = named.defval ?? positional[0] ?? null;
    const titleExpr = named.title ?? positional[1] ?? null;
    const lit = defvalExpr === null ? { literal: false, expr: null } : literalValue(defvalExpr);
    const title = titleExpr === null ? null : literalValue(titleExpr);
    const group = named.group ? literalValue(named.group) : null;
    decls.push({
      id: `in_${decls.length}`,
      index: decls.length,
      kind,
      title: title && title.literal ? title.value : null,
      title_expr: title && !title.literal ? title.expr : null,
      group: group && group.literal ? group.value : null,
      group_expr: group && !group.literal ? group.expr : null,
      ...(lit.literal ? { default: lit.value } : {}),
      default_literal: lit.literal,
      default_expr: lit.literal ? null : lit.expr,
      line: source.slice(0, m.index).split('\n').length,
    });
    INPUT_CALL.lastIndex = split.end;
  }
  return decls;
}

/**
 * Check a parse against what TradingView actually compiled.
 *
 * The parse asserts a positional mapping; this is the evidence for it. Titles
 * are compared because they are independent of position: if the parser dropped
 * or invented a declaration, every name after it shifts, and the first
 * mismatch names the id where the two diverge.
 *
 * JOINED BY ID, NOT BY ARRAY POSITION
 * -----------------------------------
 * `getInputValues()` is ordered but its index is NOT the id, and assuming it
 * was produced a clean-looking off-by-two on the first run of this check.
 * Measured on B14, 2026-09-11:
 *
 *   - script inputs occupy `in_0 .. in_325` - the 326 this parser finds;
 *   - **`in_326` and `in_327` do not exist**, a gap TradingView leaves;
 *   - `in_328 .. in_352` are the **strategy properties** - Initial Capital,
 *     Commission Value, pyramiding, Close entries rule, Risk free rate, Use
 *     Bar Magnifier and the rest. They are real inputs on a real id, settable
 *     and hashable, and they are NOT in the Pine source.
 *
 * So a manifest derived from source covers the script and cannot cover the
 * properties. They are reported here as `undeclared` rather than as errors,
 * and a manifest that wants them has to pin them explicitly - which is right,
 * because commission and Bar Magnifier change what a backtest means.
 */
export function verifyAgainstMeta(decls, chartInputs) {
  const byId = new Map(chartInputs.map((i) => [i.id, i]));
  const mismatches = [];
  const missing = [];
  let comparable = 0;
  let matched = 0;
  for (const d of decls) {
    const t = byId.get(d.id);
    if (!t) {
      missing.push({ id: d.id, source_title: d.title });
      continue;
    }
    if (d.title === null) continue;
    comparable++;
    const chartTitle = t.name ?? null;
    if (d.title === chartTitle) matched++;
    else mismatches.push({ id: d.id, source_title: d.title, chart_title: chartTitle, why: 'title' });
  }
  const declared = new Set(decls.map((d) => d.id));
  const undeclared = chartInputs.filter((i) => !declared.has(i.id)).map((i) => ({ id: i.id, name: i.name ?? null }));
  const detail = {
    source_count: decls.length,
    chart_count: chartInputs.length,
    comparable,
    matched,
    uncomparable: decls.length - comparable,
    missing_from_chart: missing,
    // Not a failure: the strategy properties live here.
    undeclared_on_chart: undeclared,
    undeclared_count: undeclared.length,
    mismatches: mismatches.slice(0, 12),
    mismatch_count: mismatches.length,
  };
  if (mismatches.length === 0 && missing.length === 0) return answered(detail);
  // A shifted title is the positional-mapping failure; a missing id is a
  // different script. Named apart so a caller can branch without re-deriving.
  return failed(mismatches.length ? 'title_mismatch' : 'missing_from_chart', detail);
}

/**
 * Build a manifest from source declarations plus an explicit override list.
 *
 * Overrides are `{ id: { value, why } }`. The reason is carried because a
 * manifest is read later by somebody deciding whether a figure is trustworthy,
 * and an unexplained override is indistinguishable from the drift this whole
 * mechanism exists to catch.
 */
export function manifestFromSource(decls, overrides = {}) {
  const map = {};
  const unpinned = [];
  for (const d of decls) {
    if (d.default_literal) map[d.id] = d.default;
    else unpinned.push({ id: d.id, title: d.title, default_expr: d.default_expr });
  }
  const applied = [];
  const unknown = [];
  for (const [id, o] of Object.entries(overrides)) {
    const d = decls.find((x) => x.id === id);
    if (!d) {
      unknown.push(id);
      continue;
    }
    applied.push({
      id,
      title: d.title,
      from: d.default_literal ? d.default : d.default_expr,
      to: o.value,
      why: o.why ?? null,
    });
    map[id] = o.value;
  }
  return { manifest: map, overrides: applied, unknown_overrides: unknown, unpinned };
}
