/**
 * Verdict construction: a success flag that a later spread cannot overwrite.
 *
 * ── THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE ──────────────────────────────
 *
 * `pine_inputs_assert` returned `ok: true` for a chart whose SCRIPT had drifted.
 * The code read, in essence:
 *
 *     const ok = cmp.ok && scriptDrift.length === 0;
 *     return { ok, ...cmp, reason: 'script_drift' };
 *
 * `compareManifest()` returns its own `ok` — "the inputs matched" — and
 * spreading it AFTER the computed verdict silently replaced the real answer
 * with a narrower one. The payload carried `reason: 'script_drift'`, a
 * populated `script_drift` array, and an error string, and `.ok` said pass.
 * Measured live 2026-09-12: manifest pinned pine 0.46, chart carried 0.51.
 *
 * An hour after fixing it, `replay_health` was written as
 * `{ ...classification, state: rawReading }` and returned the reading object
 * where `'healthy'` belonged. Same shape, same hand.
 *
 * That was a SHAPE problem, not a typo, and knowing about it demonstrably did
 * not prevent it. So:
 *
 *   - this module is the ONLY place a result's `ok` / `success` is written.
 *     eslint.config.mjs forbids those keys in any other object literal under
 *     src/, and tests/verdict-only-path.test.js runs that rule in `npm test`;
 *   - the verdict keys are written LAST and the object is frozen;
 *   - a detail object carrying a reserved key is a throw, not a silent override;
 *   - adding fields to an existing verdict goes through withDetail(), which
 *     refuses ANY key collision, reserved or not — that is the replay_health
 *     case, where the overwritten key (`state`) was an ordinary one.
 *
 * ── WHAT THE GUARD DOES NOT COVER (stated, not hidden) ─────────────────────
 *
 * A hand-written `{ ...someVerdict, state: x }` still parses and still passes
 * the lint rule, because the rule can only see literal verdict KEYS, not which
 * spread holds a verdict. Freezing prevents mutation, not a copy that overrides.
 * The copy also loses the brand, so isVerdict() is false on it — a consumer that
 * needs the guarantee checks isVerdict(). Page-context objects returned from
 * CDP evaluate() are data from the page, not verdicts, until wrapped here.
 *
 * ── THE RULE THESE HELPERS ENCODE ──────────────────────────────────────────
 *
 *   A tool may report success only if it has observed the state change it
 *   claims to have caused.
 *
 *   observed(evidence, detail)   a mutation, looked for and seen
 *   refused(reason, detail)      a mutation, looked for and NOT seen
 *   unobservable(why, detail)    a mutation whose effect cannot be read back
 *   answered(detail)             a READ that returned; claims no change
 *   failed(reason, detail)       could not produce an answer (bad argument,
 *                                not found, not settled); claims no change
 *
 * `unobservable` still returns success, because dispatching a keystroke IS the
 * whole of what `ui_keyboard` promises. What it must not do is let a caller
 * read that as "the keystroke had its intended effect".
 */

/** Keys a caller may not supply in `detail`: they are the verdict itself. */
const RESERVED = Object.freeze(['ok', 'success', 'observed', 'observation', 'evidence', 'reason']);

/** Non-enumerable, so a spread copy does not inherit it. */
const BRAND = Symbol('tvmcp.verdict');

function assertNoReservedKeys(detail, helper) {
  if (detail === undefined || detail === null) return;
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    throw new TypeError(`${helper}(): detail must be a plain object, got ${Array.isArray(detail) ? 'an array' : typeof detail}.`);
  }
  const clashes = RESERVED.filter((k) => Object.prototype.hasOwnProperty.call(detail, k));
  if (clashes.length) {
    throw new Error(
      `${helper}(): detail may not carry ${clashes.map((c) => `"${c}"`).join(', ')} — `
      + 'those keys ARE the verdict, and letting a caller supply them is the '
      + 'overwrite defect this module exists to prevent. Rename the field, or '
      + 'if it is another result, nest it under a name instead of spreading it.',
    );
  }
}

function issue(obj) {
  Object.defineProperty(obj, BRAND, { value: true, enumerable: false });
  return Object.freeze(obj);
}

function requireText(value, helper, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${helper}() requires ${what}.`);
  }
}

/** True only for an object issued by this module (not a spread copy of one). */
export function isVerdict(x) {
  return !!(x && typeof x === 'object' && x[BRAND] === true);
}

/**
 * A mutation, looked for and seen.
 *
 * @param {object} evidence what was actually read back, e.g. { chart_type_now: 1 }
 * @param {object} [detail] everything else worth returning
 */
export function observed(evidence, detail = {}) {
  if (!evidence || typeof evidence !== 'object' || Object.keys(evidence).length === 0) {
    throw new Error(
      'observed() requires non-empty evidence: the value that was read back AFTER '
      + 'the change. A success with nothing behind it is the thing this prevents.',
    );
  }
  assertNoReservedKeys(detail, 'observed');
  return issue({ ...detail, observed: true, evidence, ok: true, success: true });
}

/**
 * A mutation, looked for and NOT seen. Success is false.
 *
 * Returned rather than thrown where the caller needs the detail to diagnose;
 * throw instead when there is nothing useful to hand back.
 */
export function refused(reason, detail = {}) {
  requireText(reason, 'refused', 'a reason naming what was expected and what was found');
  assertNoReservedKeys(detail, 'refused');
  return issue({ ...detail, observed: false, reason, ok: false, success: false });
}

/**
 * A mutation whose effect genuinely cannot be observed from here.
 *
 * Use ONLY where no read-back exists — synthesised input events are the real
 * case. `why` is mandatory so that "I could not be bothered to check" cannot
 * masquerade as "it is not checkable".
 */
export function unobservable(why, detail = {}) {
  requireText(why, 'unobservable', 'a reason explaining why no read-back exists');
  assertNoReservedKeys(detail, 'unobservable');
  return issue({ ...detail, observed: false, observation: why, ok: true, success: true });
}

/**
 * A read that returned. It claims nothing changed, so it carries no
 * `observed`: success here means "this is what the chart says", not "I did it".
 */
export function answered(detail = {}) {
  assertNoReservedKeys(detail, 'answered');
  return issue({ ...detail, ok: true, success: true });
}

/**
 * Could not produce an answer, and changed nothing. `reason` is the stable
 * code a caller branches on (e.g. 'invalid_argument', 'not_found'); prose goes
 * in `detail.error`.
 */
export function failed(reason, detail = {}) {
  requireText(reason, 'failed', 'a reason code');
  assertNoReservedKeys(detail, 'failed');
  return issue({ ...detail, reason, ok: false, success: false });
}

/**
 * Decide from a predicate, so the common case is one call.
 *
 * @param {boolean} didChange the result of comparing before with after
 */
export function verdict(didChange, { evidence, reason, detail = {} }) {
  return didChange ? observed(evidence, detail) : refused(reason, detail);
}

/**
 * Add fields to an issued verdict. Refuses ANY key the verdict already has,
 * not only the reserved ones: replay_health's overwrite was of `state`, an
 * ordinary key, and a guard that only protected `success` would have let it
 * through.
 */
export function withDetail(v, extra = {}) {
  if (!isVerdict(v)) {
    throw new TypeError(
      'withDetail() takes a verdict issued by internals/verdict.js. A spread copy is not one: '
      + 'building results by spreading is the shape this module replaces.',
    );
  }
  assertNoReservedKeys(extra, 'withDetail');
  const collisions = Object.keys(extra).filter((k) => Object.prototype.hasOwnProperty.call(v, k));
  if (collisions.length) {
    throw new Error(
      `withDetail(): ${collisions.map((c) => `"${c}"`).join(', ')} already present on the verdict. `
      + 'Adding it would overwrite a value the verdict was issued with. Use a different key.',
    );
  }
  return issue({ ...v, ...extra, ...pickVerdictKeys(v) });
}

/**
 * Turn an object that carries its own verdict keys — a page-context result
 * from CDP evaluate(), or an internal reader's `{ ok, ... }` — into an issued
 * verdict, without anyone outside this module writing `ok` or `success`.
 *
 * Refuses rather than guesses:
 *   - `ok` and `success` both present and disagreeing is a throw — that
 *     disagreement is precisely the pine_inputs_assert defect;
 *   - an object carrying neither is a throw: adopt() does not invent a verdict.
 * A passing object keeps observed/evidence/observation semantics if it has
 * them; a failing one keeps its `reason` (or takes `defaultReason`).
 */
export function adopt(obj, { defaultReason = 'failed' } = {}) {
  if (isVerdict(obj)) return obj;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError(`adopt(): expected a result object, got ${Array.isArray(obj) ? 'an array' : obj === null ? 'null' : typeof obj}.`);
  }
  const hasOk = typeof obj.ok === 'boolean';
  const hasSuccess = typeof obj.success === 'boolean';
  if (hasOk && hasSuccess && obj.ok !== obj.success) {
    throw new Error(
      `adopt(): the object says ok:${obj.ok} and success:${obj.success}. A result that disagrees with itself `
      + 'is the overwrite defect; refusing to pick one.',
    );
  }
  if (!hasOk && !hasSuccess) {
    throw new Error('adopt(): the object carries no ok/success, so there is no verdict to adopt. Use answered() or failed().');
  }
  const pass = hasOk ? obj.ok : obj.success;
  const detail = {};
  for (const k of Object.keys(obj)) if (!RESERVED.includes(k)) detail[k] = obj[k];
  if (!pass) return failed(typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason : defaultReason, detail);
  if (obj.observed === true && obj.evidence && typeof obj.evidence === 'object' && Object.keys(obj.evidence).length) {
    return observed(obj.evidence, detail);
  }
  if (typeof obj.observation === 'string' && obj.observation.trim()) return unobservable(obj.observation, detail);
  return answered(detail);
}

function pickVerdictKeys(v) {
  const out = {};
  for (const k of RESERVED) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k];
  return out;
}
