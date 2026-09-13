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
import { adopt, answered, failed } from '../internals/verdict.js';

/**
 * Maximum serialised response size, in characters.
 *
 * Two ceilings matter, and the lower one wins.
 *
 * The client's. Claude Code refuses any single tool result over 25,000 tokens
 * (MAX_MCP_OUTPUT_TOKENS) — refuses, not trims: the whole response is replaced
 * by an error and a path to a file the model cannot read inline. Measured
 * 2026-09-11 through the real client, pretty-printed JSON from this bridge:
 *
 *   119,651 characters   refused
 *    86,118 characters   refused
 *    59,539 characters   refused   (a snapshot already trimmed to a 60,000 default)
 *    20,633 characters   accepted
 *
 * A crude tokeniser (runs of letters, runs of digits, each punctuation mark,
 * each whitespace run) puts every one of those payloads at 2.27–2.37
 * characters per token, and calls the 59,539 one 26,195 tokens — over the cap,
 * as the client said. Pretty-printed JSON is dense in tokens: indentation,
 * quotes, colons and short numeric fields each cost one. So the ceiling has to
 * sit well under 25,000 × 2.3 ≈ 57,000: at 40,000 the estimate is about
 * 17,500 tokens, and it would take a payload under 1.6 characters per token to
 * be refused. A default above the client's cap is worse than any trim, because
 * it turns a large answer into no answer — and the first default chosen for
 * this reason, 60,000, was itself refused through the surface.
 *
 * The bridge's own. Measured on the reference strategy (105 trades, 198 filled
 * orders), pretty-printed:
 *
 *   trade book alone                   76,929
 *   filled orders alone                50,795
 *   equity points alone                18,594
 *   report without orders or equity    86,747
 *   everything at once                164,176
 *
 * The default was 120,000 so a whole trade book passed untrimmed. A whole book
 * cannot reach the client at ANY setting, so that ceiling served only the
 * direct harness. At 40,000 the book is trimmed to roughly half its trades and
 * the trim is reported; a caller that needs the tail narrows the request.
 * Routing bulk rows to a file instead of inline is the better design and is
 * parked, not done (PARKED.md).
 *
 * Override per deployment with TV_MAX_RESPONSE_CHARS — the harness sets it to
 * 120000 to read whole books; 0 disables trimming.
 */
/**
 * Headroom set aside for the response_budget block, which is appended after
 * trimming and must not push the result back over the limit.
 */
const REPORT_RESERVE_CHARS = 900;

export const MAX_RESPONSE_CHARS =
  process.env.TV_MAX_RESPONSE_CHARS !== undefined
    ? Number(process.env.TV_MAX_RESPONSE_CHARS)
    : 40000;

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
 * of this bridge reads it. It is a mirror, not a second source of truth; both
 * are written by failed(), which also sets a top-level `reason` equal to the
 * code. A reader failure's own reason stays nested at `error.reason`.
 */
export function errorEnvelope(code, message, extra = {}) {
  return failed(code, {
    error: {
      code,
      message: String(message ?? ''),
      retry: RETRY[code] || 'now',
      ...extra,
    },
  });
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
  // Readers now return issued verdicts, so every verdict key is stripped here —
  // `success` and `observed` included — or they would ride into `error` below.
  const rest = { ...(r || {}) };
  for (const k of ['ok', 'success', 'observed', 'observation', 'evidence', 'reason', 'error']) delete rest[k];
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
 * True for a result object that carries its own verdict: a boolean `ok` or
 * `success`. Arrays and finished MCP results (a `content` array) are not.
 */
function carriesVerdict(obj) {
  return !!obj
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && !Array.isArray(obj.content)
    && (typeof obj.ok === 'boolean' || typeof obj.success === 'boolean');
}

/**
 * Format a payload as an MCP tool result, applying the response budget.
 *
 * `isError` is inferred from the envelope when not passed, so a handler
 * returning an error envelope cannot forget to flag it.
 */
export function jsonResult(obj, isError) {
  // Every tool answers with `ok`. The core layer has always returned
  // `success`; adopt() mirrors one into the other, so there is one contract
  // rather than eighty hand-edited call sites, each a chance to forget.
  //
  // A result carrying ok and success that DISAGREE is refused by adopt(). That
  // is answered here as an internal error rather than thrown, because a throw
  // out of an MCP handler loses the payload and the reason with it.
  let normalised = obj;
  if (carriesVerdict(obj)) {
    try {
      normalised = adopt(obj);
    } catch (err) {
      return jsonResult(errorEnvelope(ERROR_CODES.INTERNAL, err.message, {
        result_keys: Object.keys(obj),
      }), true);
    }
  }
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
      // DEFECT FIXED 2026-09-13: this read only `ok`, and a spread defaulting
      // ok to true then answered ok:true for a result carrying success:false —
      // which is exactly what refused() returns. Measured: handler(refused(...))
      // gave ok:true, success:false, no isError. The verdict is now taken by
      // adopt(), which reads either key and refuses a result that disagrees
      // with itself (the throw lands in the catch below as an internal error).
      if (carriesVerdict(out)) return jsonResult(adopt(out));
      // A bare payload with no verdict of its own is a read that returned.
      return jsonResult(answered(out));
    } catch (err) {
      return jsonResult(fromThrown(err, extra));
    }
  };
}
