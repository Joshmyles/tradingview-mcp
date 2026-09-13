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
 * That was a SHAPE problem, not a typo. Any `{ verdict, ...parts }` is one
 * renamed field away from the same bug, and review does not reliably catch it
 * because the offending line looks ordinary. So the shape is removed: here the
 * verdict is written LAST and the object is frozen, and a detail object that
 * carries a reserved key is a throw rather than a silent override.
 *
 * ── THE RULE THESE HELPERS ENCODE ──────────────────────────────────────────
 *
 *   A tool may report success only if it has observed the state change it
 *   claims to have caused.
 *
 * Three shapes, and the third is the important one:
 *
 *   observed(evidence, detail)      the change was looked for and seen
 *   refused(reason, detail)         it was looked for and was NOT seen
 *   unobservable(why, detail)       the effect cannot be observed from here —
 *                                   say so in the payload instead of implying
 *                                   otherwise with a bare success flag
 *
 * `unobservable` still returns success, because dispatching a keystroke IS the
 * whole of what `ui_keyboard` promises. What it must not do is let a caller
 * read that as "the keystroke had its intended effect". The distinction is
 * carried in the result, where a caller can act on it, rather than in a comment.
 */

/** Keys a caller may not supply in `detail`: they are the verdict itself. */
const RESERVED = Object.freeze(['success', 'observed', 'observation', 'evidence', 'reason']);

function assertNoReservedKeys(detail, helper) {
  if (!detail || typeof detail !== 'object') return;
  const clashes = RESERVED.filter((k) => Object.prototype.hasOwnProperty.call(detail, k));
  if (clashes.length) {
    throw new Error(
      `${helper}(): detail may not carry ${clashes.map((c) => `"${c}"`).join(', ')} — `
      + 'those keys ARE the verdict, and letting a caller supply them is the '
      + 'overwrite defect this module exists to prevent. Rename the field.',
    );
  }
}

/**
 * The change was looked for and seen.
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
  // Verdict last, then frozen: no later spread or assignment can move it.
  return Object.freeze({ ...detail, observed: true, evidence, success: true });
}

/**
 * The change was looked for and was NOT seen. Success is false.
 *
 * Returned rather than thrown where the caller needs the detail to diagnose;
 * throw instead when there is nothing useful to hand back.
 */
export function refused(reason, detail = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('refused() requires a reason naming what was expected and what was found.');
  }
  assertNoReservedKeys(detail, 'refused');
  return Object.freeze({ ...detail, observed: false, reason, success: false });
}

/**
 * The effect genuinely cannot be observed from here.
 *
 * Use ONLY where no read-back exists — synthesised input events are the real
 * case: CDP can dispatch a keystroke, and what the page then does with it is
 * not visible to the dispatcher. `why` is mandatory so that "I could not be
 * bothered to check" cannot masquerade as "it is not checkable".
 */
export function unobservable(why, detail = {}) {
  if (typeof why !== 'string' || why.trim() === '') {
    throw new Error('unobservable() requires a reason explaining why no read-back exists.');
  }
  assertNoReservedKeys(detail, 'unobservable');
  return Object.freeze({ ...detail, observed: false, observation: why, success: true });
}

/**
 * Decide from a predicate, so the common case is one call.
 *
 * @param {boolean} didChange the result of comparing before with after
 */
export function verdict(didChange, { evidence, reason, detail = {} }) {
  return didChange ? observed(evidence, detail) : refused(reason, detail);
}
