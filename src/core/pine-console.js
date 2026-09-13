/**
 * pine_console_read — the Pine debug channel.
 *
 * A cursor-based, filterable read of a study's `log.*` output, taken from the
 * study's own log collection rather than from the DOM. See
 * internals/pine-logs.js for the mechanism and for the three states an empty
 * read can mean.
 *
 * This is a READ. It gates on settle, resolves the entity explicitly, and
 * writes nothing — in particular it does not open the Pine Editor (the reader
 * it replaces did, as a side effect of scraping the console panel) and it does
 * not enable log collection. Enabling collection is an input write with a
 * recompute attached, and `indicator_set_inputs` is already the tool for that.
 */
import { evaluate } from '../connection.js';
import { requireSettled } from '../settle.js';
import { MAX_RESPONSE_CHARS } from '../tools/_format.js';
import { resolveEntity } from './pine-inputs.js';
import {
  LEVELS,
  decodeCursor,
  encodeCursor,
  levelWord,
  readLogsJs,
  resolveCursor,
  rowFingerprint,
} from '../internals/pine-logs.js';
import { adopt, answered, failed } from '../internals/verdict.js';

/**
 * Default page size.
 *
 * Measured on the reference chart: 1,266 rows at ~200 characters each is about
 * 250KB, which is twice the whole response budget. The budget would trim it
 * and say so, but a trimmed debug trace is a worse answer than a paged one —
 * the trim drops the tail, and the tail is the part a debugger wants. So the
 * tool pages by default and hands back a cursor.
 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
/**
 * Characters of rows per page, whatever `limit` asks for: three quarters of the
 * bridge's response budget, measured the way the budget measures — as the
 * pretty-printed rows the client receives, not their compact form. Derived
 * rather than fixed so an operator who lowers TV_MAX_RESPONSE_CHARS cannot
 * reopen the gap between the two truncation layers. The quarter left over is
 * for the envelope (a few hundred characters) with room to spare. With
 * trimming disabled there is no budget to derive from, and pages fall back to
 * a size just under what a client is known to refuse.
 */
const PAGE_CHAR_BUDGET = MAX_RESPONSE_CHARS > 0 ? Math.floor(MAX_RESPONSE_CHARS * 0.75) : 80000;

/** The row exactly as the response emits it, sized as the client will see it. */
function emittedRow(row) {
  return { time: row.time, bar_time: row.bar_time, level: levelWord(row.level), line: row.line, message: row.message };
}
// Rows sit two levels deep in the final document, so each of a row's seven
// lines carries four more spaces of indent than a standalone stringify shows.
const ROW_INDENT_OVERHEAD = 4 * 7;
function emittedSize(row) {
  return JSON.stringify(emittedRow(row), null, 2).length + ROW_INDENT_OVERHEAD;
}

export async function pineConsoleRead({
  entityId = null,
  sinceCursor = null,
  prefix = null,
  level = null,
  limit = DEFAULT_LIMIT,
  wait = true,
  _deps,
} = {}) {
  const ev = _deps?.evaluate || evaluate;

  if (level != null && !LEVELS.includes(String(level))) {
    return failed('invalid_argument', {
      error: `level must be one of ${LEVELS.join(', ')}; got "${level}".`,
    });
  }
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) {
    return failed('invalid_argument', { error: `limit must be a positive number; got "${limit}".` });
  }
  const pageSize = Math.min(Math.floor(n), MAX_LIMIT);
  // A cursor this tool never issued is refused whatever state the collection
  // is in. Checked only after the empty-state returns, it slipped through
  // whenever collection was disabled or absent.
  if (sinceCursor && decodeCursor(sinceCursor).invalid) {
    return failed('invalid_cursor', { error: 'since_cursor is not a cursor this tool issued. Pass next_cursor back unchanged, or omit it to read from the start.' });
  }

  // Resolve first, so a chart carrying two builds refuses rather than reading
  // whichever came first out of dataSources().
  const r = await resolveEntity({ hint: entityId, _deps });
  if (!r.ok) {
    return failed(r.reason === 'ambiguous' ? 'ambiguous_entity' : r.reason || 'resolve_failed', {
      error: r.error,
      candidates: r.candidates,
    });
  }
  const target = r.resolved;

  if (wait) {
    const gate = await requireSettled({ entityId: target.entity_id, scope: 'target' });
    if (!gate.ok) return gate;
  }

  const raw = await ev(readLogsJs(JSON.stringify(target.entity_id)));
  if (!raw) return failed('no_result', { error: 'The page returned nothing.' });
  // The page script sets ok on every path; an object without one is not a
  // result, and adopt() refuses to invent a verdict for it.
  if (typeof raw.ok !== 'boolean' && typeof raw.success !== 'boolean') {
    return failed('internal', { error: 'The page returned a result without a verdict.' });
  }
  if (!raw.ok) return adopt(raw, { defaultReason: 'internal' });

  const base = {
    entity_id: raw.entity_id,
    title: raw.title,
    pine_version: raw.pine_version,
    collection: raw.collection,
    log_level_mask: raw.mask,
    total: raw.total,
  };

  // An empty read has three causes and they are not interchangeable. Saying
  // which one it is IS the result; returning [] and letting the caller assume
  // the script is quiet is the wrong answer this tool exists to avoid.
  if (raw.collection === 'absent') {
    return answered({
      ...base,
      rows: [],
      note:
        'This script emits no log.* calls at all — TradingView does not even create a log collection for it ' +
        '(metaInfo carries no graphics.logs). This is not "logging is off" and not "nothing logged yet".',
    });
  }
  if (raw.collection === 'disabled') {
    return answered({
      ...base,
      rows: [],
      note:
        'Log collection is OFF for this study: every level in log_level_mask is false, so TradingView discards ' +
        'the rows as they are produced and the collection sits at 0. An empty result here says nothing about ' +
        'whether the script logged. Turn collection on by writing the __log_level input ' +
        '(error 1 | warning 2 | info 4, so 7 is all three) with indicator_set_inputs, which forces a recompute. ' +
        '__log_level is excluded from the fence allowlist and is in no build manifest, so changing it neither ' +
        'trips inputs_drifted nor moves manifest_hash — and equally, nothing in this bridge will notice it later.',
    });
  }

  const all = raw.rows;
  const cur = resolveCursor(sinceCursor, all);
  if (!cur.ok) {
    const { ok: _ok, success: _success, reason: curReason, ...curDetail } = cur;
    return failed(curReason, { ...base, ...curDetail });
  }

  // Filter AFTER the cursor resolves. The cursor indexes the unfiltered
  // collection, because a filter is the caller's question and the position has
  // to mean the same thing to the next call with a different one.
  const after = all.slice(cur.from);
  const wantLevel = level == null ? null : String(level);
  const wantPrefix = prefix == null ? null : String(prefix);
  const matched = after.filter((row) => {
    if (wantLevel && levelWord(row.level) !== wantLevel) return false;
    if (wantPrefix && !String(row.message).startsWith(wantPrefix)) return false;
    return true;
  });

  // Cap the page by SIZE as well as by count, and do it here. Measured through
  // the real server 2026-09-11: limit 500 built a 119,651-char page, the
  // global response budget then dropped 43 rows off its end, and next_cursor —
  // computed for 500 — skipped those 43. Two truncation layers that disagree
  // lose rows. The cap sits below both the bridge budget and what an MCP client
  // will accept, so the global trim never touches a console page.
  const page = [];
  let chars = 0;
  for (const row of matched) {
    if (page.length >= pageSize) break;
    const size = emittedSize(row);
    if (page.length > 0 && chars + size > PAGE_CHAR_BUDGET) break;
    page.push(row);
    chars += size;
  }
  const truncated = matched.length > page.length;
  const cutBySize = truncated && page.length < pageSize;

  // The cursor advances over the UNFILTERED collection, so the next call
  // resumes where this one genuinely stopped reading rather than where the
  // filter happened to stop matching.
  let consumed = all.length;
  if (truncated) {
    const lastKept = page[page.length - 1];
    consumed = cur.from + after.indexOf(lastKept) + 1;
  }
  const nextCursor = encodeCursor({
    n: consumed,
    head: rowFingerprint(all[0]),
    prev: rowFingerprint(all[consumed - 1]),
  });

  return answered({
    ...base,
    ...(cur.fresh ? {} : { resumed_from: cur.from }),
    returned: page.length,
    matched: matched.length,
    scanned: after.length,
    ...(wantPrefix && { prefix: wantPrefix }),
    ...(wantLevel && { level: wantLevel }),
    rows: page.map(emittedRow),
    next_cursor: nextCursor,
    truncation: truncated
      ? {
          applied: true,
          reason: cutBySize ? 'size' : 'limit',
          returned: page.length,
          matched: matched.length,
          dropped: matched.length - page.length,
          ...(cutBySize && { page_char_budget: PAGE_CHAR_BUDGET }),
          note:
            (cutBySize
              ? `The page stopped at ${PAGE_CHAR_BUDGET} characters of rows before reaching limit. `
              : 'Rows were dropped from the END of the matching set to fit limit. ') +
            'Pass next_cursor to continue from exactly where this page stopped; the cursor indexes the whole ' +
            'collection, not the filtered view.',
        }
      : { applied: false, note: 'Every matching row from the cursor onward is in this page.' },
    note:
      'line is the Pine source line that emitted the row. The collection is REBUILT on every recompute, and on a ' +
      'live seconds chart that is every bar — a cursor is validated against the log head and the row it resumes ' +
      'after, and is refused as cursor_stale rather than silently returning a different slice.',
  });
}
