/**
 * MCP response envelope and response budget.
 *
 * Two jobs, both about what a caller can rely on:
 *
 *   1. Every tool answers in one shape, so "did this work" is a field lookup
 *      rather than a guess from which keys happen to be present.
 *   2. No response silently exceeds what a caller can afford to read. When a
 *      payload is trimmed, the trim is reported — an unmarked truncation is a
 *      wrong answer, not a large one.
 */

/**
 * Maximum serialised response size, in characters.
 *
 * Chosen against the failure it prevents — a single pine_get_source or an
 * unsummarised bar pull can return 200KB+, costing more context than the whole
 * task it was serving — and against the payload it must NOT damage. Measured
 * on the reference strategy (105 trades, 198 filled orders), pretty-printed:
 *
 *   trade book alone                   76,929
 *   filled orders alone                50,795
 *   equity points alone                18,594
 *   report without orders or equity    86,747
 *   everything at once                164,176
 *
 * The trade book is the deliverable here, not incidental bulk, so the limit
 * has to clear it comfortably. At 60,000 a full report was trimmed to 37 of
 * 105 trades by default, which is the tool quietly failing at its job while
 * reporting that it had. 120,000 passes any single-aspect read whole and trims
 * only a request for the entire book plus every order plus the curve.
 *
 * Override per deployment with TV_MAX_RESPONSE_CHARS; 0 disables trimming.
 */
/**
 * Headroom set aside for the response_budget block, which is appended after
 * trimming and must not push the result back over the limit.
 */
const REPORT_RESERVE_CHARS = 900;

export const MAX_RESPONSE_CHARS =
  process.env.TV_MAX_RESPONSE_CHARS !== undefined
    ? Number(process.env.TV_MAX_RESPONSE_CHARS)
    : 120000;

/**
 * Error codes. Stable strings, because a caller branching on prose breaks the
 * first time the prose improves.
 *
 * The settle outcomes deliberately reuse the SETTLE vocabulary from settle.js
 * so a gate failure keeps its identity all the way out to the caller.
 */
export const ERROR_CODES = {
  /** The chart is not in a state where the answer exists yet. */
  NOT_SETTLED: 'not_settled',
  /** Gate outcomes, passed through verbatim. */
  TIMED_OUT: 'timed_out',
  STUCK: 'stuck',
  ERRORED: 'errored',
  ABSENT: 'absent',
  /** The report does not describe the state that was requested. */
  WINDOW_MISMATCH: 'window_mismatch',
  /** Asked for something that is not on the chart. */
  NOT_FOUND: 'not_found',
  /** Bad arguments. Retrying unchanged cannot help. */
  INVALID_ARGUMENT: 'invalid_argument',
  /** The bridge could not reach or drive TradingView. */
  UNAVAILABLE: 'unavailable',
  /** Anything not yet classified. */
  INTERNAL: 'internal',
};

/** Whether retrying the same call could plausibly succeed. */
const RETRY = {
  [ERROR_CODES.NOT_SETTLED]: 'after_settle',
  [ERROR_CODES.TIMED_OUT]: 'after_settle',
  [ERROR_CODES.STUCK]: 'never',
  [ERROR_CODES.ERRORED]: 'never',
  [ERROR_CODES.ABSENT]: 'never',
  [ERROR_CODES.WINDOW_MISMATCH]: 'after_settle',
  [ERROR_CODES.NOT_FOUND]: 'never',
  [ERROR_CODES.INVALID_ARGUMENT]: 'never',
  [ERROR_CODES.UNAVAILABLE]: 'now',
  [ERROR_CODES.INTERNAL]: 'now',
};

/**
 * Classify a thrown Error.
 *
 * Deliberately conservative: an unrecognised message is INTERNAL, not a guess.
 * A wrong code is worse than an unhelpful one, because a caller acts on it.
 */
export function classifyError(err) {
  const msg = String(err?.message || err || '');
  if (
    /CDP connection failed|No TradingView chart|No visible TradingView chart|not available at|is the tab still open/i.test(
      msg,
    )
  ) {
    return ERROR_CODES.UNAVAILABLE;
  }
  if (/not found|No matching element|does not exist/i.test(msg)) {
    return ERROR_CODES.NOT_FOUND;
  }
  if (/must be a finite number|Invalid |expected a /i.test(msg)) {
    return ERROR_CODES.INVALID_ARGUMENT;
  }
  return ERROR_CODES.INTERNAL;
}

/**
 * The error half of the envelope.
 *
 * `success: false` is kept alongside `ok: false` because every existing caller
 * of this bridge reads it. It is a mirror, not a second source of truth.
 */
export function errorEnvelope(code, message, extra = {}) {
  return {
    ok: false,
    success: false,
    error: {
      code,
      message: String(message ?? ''),
      retry: RETRY[code] || 'now',
      ...extra,
    },
  };
}

/** Build the envelope for a thrown Error, classifying it. */
export function fromThrown(err, extra = {}) {
  return errorEnvelope(classifyError(err), err?.message || String(err), extra);
}

/**
 * Convert a gated reader's `{ ok: false, reason, error, ... }` into the
 * envelope, preserving everything it collected as evidence.
 *
 * The readers report a settle outcome as `reason`; those strings are already
 * the codes, so they pass straight through rather than being re-mapped.
 */
export function fromReaderFailure(r, extra = {}) {
  const known = Object.values(ERROR_CODES).includes(r?.reason);
  const code = known
    ? r.reason
    : r?.reason === 'report_not_computed' || r?.reason === 'no_strategy'
      ? ERROR_CODES.NOT_FOUND
      : ERROR_CODES.NOT_SETTLED;
  const rest = { ...(r || {}) };
  delete rest.ok;
  delete rest.reason;
  delete rest.error;
  return errorEnvelope(code, r?.error, { reason: r?.reason, ...rest, ...extra });
}

// --- Response budget -----------------------------------------------------

/**
 * Every array in the payload that is not itself inside another array.
 *
 * Nested arrays are excluded because trimming the container already drops
 * them; counting both would report the same loss twice.
 */
function collectArrays(node, path, out) {
  if (Array.isArray(node)) {
    out.push({ path, arr: node });
    return out;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      collectArrays(node[k], path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

function setAtPath(root, path, value) {
  const parts = path.split('.').filter(Boolean);
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  node[parts[parts.length - 1]] = value;
}

/**
 * Trim a payload to fit the budget by shortening its arrays.
 *
 * Every array is scaled by the SAME factor, and the factor is the largest one
 * that fits. Trimming the biggest array first instead would annihilate one
 * list while leaving another almost intact, purely because of which sorted
 * first — and a caller comparing trades against orders would be reading two
 * different depths of the same book without being told.
 *
 * Rows are dropped from the END, so the head of any ordered series survives.
 * What was dropped is recorded per array; a caller that needs the tail must
 * narrow the request instead.
 *
 * Returns { payload, report }, report null when nothing was trimmed.
 */
export function applyBudget(payload, maxChars = MAX_RESPONSE_CHARS) {
  if (!maxChars || maxChars <= 0) return { payload, report: null };
  const originalChars = JSON.stringify(payload, null, 2).length;
  if (originalChars <= maxChars) return { payload, report: null };

  // The report block is added to the payload after trimming, so it has to be
  // paid for before. Without this the budget is overshot by exactly the size
  // of the notice explaining that the budget was respected.
  const target = Math.max(200, maxChars - REPORT_RESERVE_CHARS);

  const arrays = collectArrays(payload, '', []).filter((a) => a.arr.length > 1);
  if (!arrays.length) {
    // Nothing array-shaped to trim. A single huge string (a Pine source, say)
    // is returned whole rather than cut mid-token, and said so.
    return {
      payload,
      report: {
        applied: false,
        limit_chars: maxChars,
        original_chars: originalChars,
        final_chars: originalChars,
        truncated: [],
        note: 'This response exceeds the size budget but holds no trimmable list, so it was returned in full. Request less of it.',
      },
    };
  }

  const render = (scale) => {
    const clone = JSON.parse(JSON.stringify(payload));
    const kept = [];
    for (const a of arrays) {
      const keep = Math.max(1, Math.min(a.arr.length, Math.ceil(a.arr.length * scale)));
      setAtPath(clone, a.path, a.arr.slice(0, keep));
      kept.push({ path: a.path, kept: keep, of: a.arr.length, dropped: a.arr.length - keep });
    }
    return { clone, kept, chars: JSON.stringify(clone, null, 2).length };
  };

  // Binary search the scale factor. Measuring the real serialised length beats
  // estimating from a per-row average: the budget counts indented output while
  // rows are neither uniform nor indented alike, and both errors run toward
  // discarding far more than the budget required.
  let lo = 0;
  let hi = 1;
  let best = render(0);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const attempt = render(mid);
    if (attempt.chars <= target) {
      best = attempt;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return {
    payload: best.clone,
    report: {
      applied: true,
      limit_chars: maxChars,
      original_chars: originalChars,
      final_chars: best.chars,
      truncated: best.kept.filter((k) => k.dropped > 0),
      note: 'This response exceeded the size budget and was trimmed. Rows were dropped from the END of the listed arrays and the counts above are exact. Narrow the request (summary, a limit, a study_filter, a smaller range) rather than assuming the omitted rows resemble the ones returned.',
    },
  };
}

/**
 * Format a payload as an MCP tool result, applying the response budget.
 *
 * `isError` is inferred from the envelope when not passed, so a handler
 * returning an error envelope cannot forget to flag it.
 */
export function jsonResult(obj, isError) {
  // Every tool answers with `ok`. The core layer has always returned
  // `success`, and mirroring it here means one contract rather than eighty
  // hand-edited call sites, each of which is a chance to forget.
  const normalised =
    obj && typeof obj === 'object' && !Array.isArray(obj) && obj.ok === undefined && typeof obj.success === 'boolean'
      ? { ok: obj.success, ...obj }
      : obj;
  const flagged = isError !== undefined ? isError : normalised?.ok === false;
  const { payload, report } = applyBudget(normalised);
  const body = report ? { ...payload, response_budget: report } : payload;
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    ...(flagged && { isError: true }),
  };
}

/**
 * Wrap a tool handler so every thrown error becomes the same envelope.
 *
 * Handlers are written as if they cannot fail; the classification and the
 * shape live here rather than being retyped at eighty call sites, where they
 * drifted.
 */
export function handler(fn, extra = {}) {
  return async (...args) => {
    try {
      const out = await fn(...args);
      // A handler may return a finished MCP result, or a bare payload.
      if (out && Array.isArray(out.content)) return out;
      if (out && out.ok === false) return jsonResult(out);
      return jsonResult({ ok: true, ...out });
    } catch (err) {
      return jsonResult(fromThrown(err, extra));
    }
  };
}
