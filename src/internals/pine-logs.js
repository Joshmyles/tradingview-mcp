/**
 * Pine logs — the debug channel, read from the study's own log collection.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * ## What this is not
 *
 * It is not a second data bus. `reportData` carries the book, the orders and
 * the performance; anything a measurement depends on belongs there. This is
 * the channel for `log.info` / `log.warning` / `log.error` — what the script
 * says about itself while it runs. Build 14 emits 25 such calls in prefixed
 * families (`CFG|`, `CENSUS|`, `TELX|`, `TRADE|`), which is a debug trace, not
 * a dataset.
 *
 * ## Where the logs actually live
 *
 * Not in the DOM, and not behind the Pine Editor. Every study DATA SOURCE
 * exposes `logs()`, whose implementation on Desktop 3.4.1 is:
 *
 *   logs() {
 *     return this._metaInfo.value().graphics.logs &&
 *            this._graphics instanceof LiveStudyGraphics
 *       ? ensureDefined(this._graphics.observableLogs().get("logs"))
 *       : null;
 *   }
 *
 * Two consequences, both measured 2026-09-11 on the reference chart:
 *
 *   - It returns **null** for a study whose script emits no `log.*` call at
 *     all — the metaInfo simply does not declare `graphics.logs`. Of the 13
 *     user studies on the reference chart, 12 returned null and only `xVbiv5`
 *     ("B14") returned a collection. `null` therefore means "this script does
 *     not log", NOT "logging is off" and NOT "no logs yet". They are three
 *     different states and a reader that collapses them reports the wrong one.
 *   - It needs no panel, no editor, and no React fiber walk. The previous
 *     console reader opened the Pine Editor as a side effect and scraped
 *     `[class*="consoleRow"]`; this one touches neither the DOM nor the
 *     editor.
 *
 * ## The wrong answer this is built to avoid
 *
 * `logLevelMask()` reads `{ error, warning, info }` and on the reference chart
 * all three were **false**. With the mask off the collection is present and
 * its size is **0**. An empty array is therefore indistinguishable from "the
 * script logged nothing" unless the mask is reported alongside it — and the
 * script in question emits over a thousand lines a window. Measured: mask off,
 * size 0; mask on, size **1266** (CENSUS 1118, TELX 116, RVX 18, MINX 12,
 * CFG 2) after a recompute.
 *
 * So `readLogsJs` always returns the mask and a `collection` word, and the
 * core layer refuses to present an empty read as a result.
 *
 * ## The mask is an INPUT, and it is outside the fence
 *
 * `setLogLevelMask({error, warning, info})` packs the flags to a bitmask
 * (`error 1 | warning 2 | info 4`) and writes `inputs.__log_level`. That is a
 * real study input, so enabling collection forces a recompute — but it is one
 * of the eight keys deliberately excluded from the fence's input allowlist
 * (see study-state.js), so it neither trips `inputs_drifted` nor moves
 * `manifest_hash`. It is also in neither build manifest, because it is not an
 * `input.*` declaration in the source.
 *
 * That cuts both ways and both halves matter: reading logs cannot manufacture
 * false configuration drift, and equally, a change to the log level is
 * invisible to every check this bridge has. It is a debug setting, and it is
 * recorded here as one.
 *
 * Writing it is NOT this module's job. `indicator_set_inputs` already writes
 * inputs by id and is the mutation path; this stays a read.
 *
 * ## extract() DESTROYS the collection
 *
 *   extract() { const e = new Set(this._primitivesDataById.values());
 *               return this.clearPrimitives(), e }
 *
 * It is the obvious-looking way to get every row out in one call, and it
 * empties the log as a side effect — a read that silently destroys what the
 * next read was going to return. `forEach` is non-destructive and is the only
 * accessor used here. `keys()` throws "Not implemented" on this build.
 *
 * ## Row shape
 *
 *   { barTime, time, level, source: { start: {line, column}, end: {...} },
 *     message }
 *
 * `source.start.line` is the line in the Pine source that emitted the row,
 * which is the part worth keeping: a log line that cannot be traced back to
 * the statement that wrote it is a string. `level` carries the same bit values
 * the mask packs, so 4 is info.
 */
import { answered, failed } from './verdict.js';

/** Pine log level bits — the same values setLogLevelMask packs. */
const LEVEL_BITS = { error: 1, warning: 2, info: 4 };

/** Decode a row's numeric level to a word. Unknown values are reported, not guessed. */
export function levelWord(bit) {
  for (const [word, value] of Object.entries(LEVEL_BITS)) {
    if (value === bit) return word;
  }
  return `unknown_${bit}`;
}

/** Encode a set of level words to the mask bitfield. */
export function levelMaskValue({ error = false, warning = false, info = false } = {}) {
  return (error ? LEVEL_BITS.error : 0) | (warning ? LEVEL_BITS.warning : 0) | (info ? LEVEL_BITS.info : 0);
}

/** The level words this build understands, for validating a filter. */
export const LEVELS = Object.keys(LEVEL_BITS);

function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `0000000${h.toString(16)}`.slice(-8);
}

/** Identity of one row, for cursor validation. Time plus text, not position. */
export function rowFingerprint(row) {
  if (!row) return null;
  return fnv(`${row.time}|${row.level}|${row.message}`);
}

/**
 * Page-context JS: read a study's log collection without disturbing it.
 *
 * Returns `{ ok, entity_id, title, pine_version, mask, collection, total,
 * rows }`, where `collection` is one of:
 *
 *   'absent'    logs() returned null — this script emits no log.* call
 *   'disabled'  the collection exists and every mask level is off
 *   'present'   the collection exists and at least one level is on
 *
 * `rows` is the whole collection in insertion order. Slicing happens in the
 * core layer, where the cursor lives; doing it here would mean re-evaluating
 * a page expression for every page of the same generation.
 */
export function readLogsJs(entityIdExpr) {
  return `
  (function() {
    try {
      var cw = window.TradingViewApi._activeChartWidgetWV.value();
      var srcs = cw._chartWidget.model().model().dataSources();
      var want = ${entityIdExpr};
      var s = null;
      for (var i = 0; i < srcs.length; i++) {
        var id = null;
        try { id = typeof srcs[i].id === 'function' ? srcs[i].id() : srcs[i].id; } catch (e) { continue; }
        if (id === want) { s = srcs[i]; break; }
      }
      if (!s) return { ok: false, reason: 'not_found', error: 'No study ' + want + ' on this chart.' };

      var title = null;
      try { title = typeof s.title === 'function' ? s.title() : s.title; } catch (e) {}
      var pineVersion = null;
      try {
        var vals = cw.getStudyById(want).getInputValues();
        for (var v = 0; v < vals.length; v++) if (vals[v].id === 'pineVersion') pineVersion = vals[v].value;
      } catch (e) {}

      var mask = null;
      try { mask = s.logLevelMask(); } catch (e) {}

      var lg = null;
      try { lg = s.logs(); } catch (e) {
        return { ok: false, reason: 'logs_unavailable', error: String(e && e.message || e) };
      }
      if (!lg) {
        return {
          ok: true, entity_id: want, title: title, pine_version: pineVersion,
          mask: mask, collection: 'absent', total: 0, rows: []
        };
      }

      var size = null;
      try { size = typeof lg.size === 'function' ? lg.size() : lg.size; } catch (e) {}

      // forEach ONLY. extract() would empty the collection as a side effect.
      var rows = [];
      lg.forEach(function (row) {
        if (!row) return;
        var src = row.source && row.source.start ? row.source.start : null;
        rows.push({
          bar_time: row.barTime != null ? row.barTime : null,
          time: row.time != null ? row.time : null,
          level: row.level != null ? row.level : null,
          line: src && src.line != null ? src.line : null,
          column: src && src.column != null ? src.column : null,
          message: typeof row.message === 'string' ? row.message : String(row.message)
        });
      });

      var anyOn = !!(mask && (mask.error || mask.warning || mask.info));
      return {
        ok: true, entity_id: want, title: title, pine_version: pineVersion,
        mask: mask, collection: anyOn ? 'present' : 'disabled',
        total: rows.length, reported_size: size, rows: rows
      };
    } catch (e) {
      return { ok: false, reason: 'internal', error: String(e && e.message || e) };
    }
  })()`;
}

/**
 * Encode a cursor.
 *
 * Opaque to the caller on purpose: its validity rules are this module's, and a
 * caller that constructs one by hand is asserting a generation it never read.
 */
export function encodeCursor({ n, head, prev }) {
  return Buffer.from(JSON.stringify({ n, head, prev }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const c = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof c?.n !== 'number' || c.n < 0) return { invalid: true };
    return c;
  } catch {
    return { invalid: true };
  }
}

/**
 * Where to resume from, or why the cursor cannot be honoured.
 *
 * The collection is REBUILT on every recompute, and on a live seconds chart
 * that is every bar. A positional cursor is therefore only meaningful inside
 * one generation, and a reader that trusts the position alone silently returns
 * the wrong slice the first time history rolls — the same class of bug as a
 * level predicate across a mutation boundary.
 *
 * Two checks, both cheap, both required:
 *
 *   head  the first row's fingerprint. A 45S chart holds a rolling ~21,000-bar
 *         window, so when history rolls the earliest log lines fall off and
 *         the head moves. Same head means the same starting point.
 *   prev  the fingerprint of the last row the caller was given. Catches the
 *         case the head cannot see: the head is unchanged but rows in the
 *         middle were regenerated differently, which is what an input change
 *         does.
 *
 * A stale cursor is REFUSED, not silently reset. Returning the whole log to a
 * caller who asked for "what is new" would read as a thousand new lines.
 */
export function resolveCursor(cursor, rows) {
  const c = decodeCursor(cursor);
  if (!c) return answered({ from: 0, fresh: true });
  if (c.invalid) {
    return failed('invalid_cursor', { error: 'since_cursor is not a cursor this tool issued. Cursors are opaque; pass back the next_cursor from a previous read.' });
  }
  const head = rowFingerprint(rows[0]);
  if (c.n > rows.length) {
    return failed('cursor_stale', {
      error: `The cursor is at row ${c.n} and the log now holds ${rows.length}. The collection was rebuilt and is shorter than it was, so the position means nothing. Re-read without a cursor.`,
      cursor_n: c.n,
      total: rows.length,
    });
  }
  if (c.head && head && c.head !== head) {
    return failed('cursor_stale', {
      error: 'The log no longer starts where it did when this cursor was issued — history has rolled or the study was recomputed from a different first bar. Re-read without a cursor.',
      cursor_head: c.head,
      observed_head: head,
    });
  }
  if (c.prev && c.n > 0) {
    const prev = rowFingerprint(rows[c.n - 1]);
    if (prev && prev !== c.prev) {
      return failed('cursor_stale', {
        error: 'The row this cursor was resuming after has changed, so the rows in between are not the ones already seen. The script was recomputed under a different configuration. Re-read without a cursor.',
        cursor_prev: c.prev,
        observed_prev: prev,
      });
    }
  }
  return answered({ from: c.n, fresh: false });
}
