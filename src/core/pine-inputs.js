/**
 * Input-manifest recipes: snapshot, assert, and resolve a study by name.
 *
 * These are the answer to "which configuration does this number describe?",
 * which until now nothing in the bridge could state. See internals/inputs.js
 * for why a hash was not enough.
 */
import { evaluate } from '../connection.js';
import {
  annotate,
  buildKey,
  checkBuild,
  compareManifest,
  inputsSnapshotJs,
  manifestHash,
  readManifest,
  toManifest,
} from '../internals/inputs.js';
import { adopt, answered, failed } from '../internals/verdict.js';

/**
 * A page read that did not answer `ok: true`, as a verdict.
 *
 * The page's own `{ ok: false, reason, error }` is adopted with its reason
 * intact; nothing at all, or an object carrying no verdict, is `no_result`.
 */
function pageFailure(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (typeof raw.ok === 'boolean' || typeof raw.success === 'boolean')) {
    return adopt(raw, { defaultReason: 'no_result' });
  }
  return failed('no_result', { error: 'The page returned nothing.' });
}

/**
 * Every study on the chart, with enough identity to pick one.
 *
 * Exists because every other tool takes an `entity_id` that the caller has to
 * have got from somewhere, and "somewhere" was a full chart state read. A
 * strategy is a source exposing `reportData()`; that is the only reliable
 * discriminator, since titles are user-editable and ids are opaque.
 */
export async function resolveEntity({ hint = null, _deps } = {}) {
  const ev = _deps?.evaluate || evaluate;
  const listed = await ev(`
  (function() {
    try {
      var cw = window.TradingViewApi._activeChartWidgetWV.value();
      var srcs = cw._chartWidget.model().model().dataSources();
      var out = [];
      for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i];
        var id = null;
        try { id = typeof s.id === 'function' ? s.id() : s.id; } catch (e) {}
        if (!id) continue;
        var title = null;
        try { title = typeof s.title === 'function' ? s.title() : s.title; } catch (e) {}
        var isStrategy = typeof s.reportData === 'function';
        var hasReport = false;
        if (isStrategy) { try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); hasReport = !!(rd && rd.trades); } catch (e) {} }
        out.push({ entity_id: id, title: title, is_strategy: isStrategy, report_present: hasReport });
      }
      return { ok: true, symbol: cw.symbol(), resolution: cw.resolution(), studies: out };
    } catch (e) { return { ok: false, reason: 'resolve_failed', error: String(e && e.message || e) }; }
  })()`);
  if (!listed?.ok) return pageFailure(listed);
  // The page's own verdict keys are dropped here; the verdict below is issued
  // from what was matched, not carried over from the listing.
  const { ok: _pageOk, success: _pageSuccess, reason: _pageReason, ...listedDetail } = listed;

  const studies = listed.studies.map((s) => ({ ...s, build: buildKey(s.title) }));

  // Matching runs in tiers, most specific first, and stops at the first tier
  // that matches anything. Without the exact-title tier a chart carrying B14
  // and "B14 copy" would be permanently unresolvable by name: substring
  // matching alone has no way to say "this one, exactly".
  let candidates;
  let matched_by = null;
  if (hint) {
    const needle = String(hint).trim().toLowerCase();
    const byId = studies.filter((s) => s.entity_id === hint);
    const byTitle = studies.filter((s) => (s.title || '').trim().toLowerCase() === needle);
    const bySubstring = studies.filter((s) => (s.title || '').toLowerCase().includes(needle));
    if (byId.length) { candidates = byId; matched_by = 'entity_id'; }
    else if (byTitle.length) { candidates = byTitle; matched_by = 'exact_title'; }
    else { candidates = bySubstring; matched_by = 'title_substring'; }
  } else {
    // With no hint the useful answer is the strategy that actually has a
    // report; a strategy still computing is not yet an answer to anything.
    const withReport = studies.filter((s) => s.is_strategy && s.report_present);
    candidates = withReport.length ? withReport : studies.filter((s) => s.is_strategy);
    matched_by = withReport.length ? 'only_strategy_with_report' : 'only_strategy';
  }

  if (candidates.length === 1) {
    return answered({ ...listedDetail, studies, resolved: candidates[0], candidates, matched_by, ambiguous: false });
  }

  // AMBIGUITY IS A REFUSAL, NOT A TIE-BREAK.
  //
  // Build 14 is titled "B14" and build 15 will be "B15"; both can be loaded on
  // one chart at once, and a prefix or substring matches both. Returning the
  // first would attach every subsequent read, assert and backtest to whichever
  // study happened to come first out of `dataSources()` - and nothing
  // downstream could tell afterwards that it had happened.
  return failed(candidates.length ? 'ambiguous' : 'not_found', {
    error: candidates.length
      ? `${candidates.length} studies match${hint ? ` "${hint}"` : ''}: ` +
        `${candidates.map((c) => `${c.title || '(untitled)'} (${c.entity_id})`).join(', ')}. ` +
        'Pass entity_id, or the exact title. Refusing rather than picking one, because two builds on one chart are not interchangeable.'
      : hint
        ? `No study matches ${hint}.`
        : 'No strategy on this chart.',
    symbol: listed.symbol,
    resolution: listed.resolution,
    matched_by,
    candidates,
    studies,
  });
}

/**
 * Resolve to exactly one study, or return the refusal to hand straight back.
 *
 * Every path that reads or asserts a configuration goes through this, so that
 * "which study is this about" is answered once, explicitly, and the answer is
 * carried on the result rather than re-derived per call by whichever rule that
 * call happened to implement.
 */
async function resolveOne({ entityId = null, _deps } = {}) {
  const r = await resolveEntity({ hint: entityId, _deps });
  if (!r.ok) {
    return failed(r.reason === 'ambiguous' ? 'ambiguous_entity' : r.reason, {
      error: r.error,
      candidates: r.candidates,
      symbol: r.symbol,
      resolution: r.resolution,
    });
  }
  return answered({ ...r.resolved, symbol: r.symbol, resolution: r.resolution });
}

/**
 * Read the study's configuration.
 *
 * `include` controls the payload, because all 351 inputs is ~8KB of mostly
 * defaults: by default only the inputs that DIFFER from their compiled default
 * are listed, which is the set that actually describes this build. `'all'`
 * lists everything, `'manifest'` adds the compact id-to-value map to hand to
 * `pine_inputs_assert`.
 */
export async function pineInputsSnapshot({ entityId = null, include = [], _deps } = {}) {
  const ev = _deps?.evaluate || evaluate;
  const want = new Set(include);
  // Resolve before reading, so a chart carrying two builds refuses instead of
  // snapshotting whichever one came first out of dataSources().
  const target = await resolveOne({ entityId, _deps });
  if (!target.ok) return target;
  const raw = await ev(inputsSnapshotJs(JSON.stringify(target.entity_id)));
  if (!raw?.ok) return pageFailure(raw);

  const inputs = annotate(raw.inputs);
  const map = toManifest(raw.inputs);
  const nonDefault = inputs.filter((i) => i.is_default === false);
  const unknownDefault = inputs.filter((i) => i.is_default === null);

  return answered({
    entity_id: raw.entity_id,
    title: raw.title,
    build: buildKey(raw.title),
    symbol: raw.symbol,
    resolution: raw.resolution,
    pine_id: raw.pine_id,
    pine_version: raw.pine_version,
    manifest_hash: manifestHash(map),
    count: inputs.length,
    non_default_count: nonDefault.length,
    ...(unknownDefault.length && { defaults_unknown_count: unknownDefault.length }),
    non_default: nonDefault,
    ...(want.has('all') && { inputs }),
    ...(want.has('manifest') && { manifest: map }),
    note:
      'non_default lists only inputs that differ from the compiled default, which is the set that describes this build. ' +
      'manifest_hash covers ALL inputs, so it changes when a default-valued input moves too. ' +
      'pine_id and pine_version identify the script itself: a manifest that matches on values while these differ is a false pass.',
  });
}

/**
 * Assert the chart is carrying the configuration you meant.
 *
 * Refuses rather than warns. The point of this tool is to be the thing that
 * stops a measurement, so a soft pass would defeat it.
 */
export async function pineInputsAssert({
  manifest = null,
  build = null,
  entityId = null,
  pineId = null,
  pineVersion = null,
  requireComplete = false,
  _deps,
} = {}) {
  // Accepts a bare map, a whole snapshot, or a committed manifest file: the
  // obvious thing to do with any of them is hand it straight back, and failing
  // on that is a trap.
  const parsed = readManifest(manifest);
  if (!parsed.ok) return parsed;
  const expected = parsed.expected;
  const expectPineId = pineId ?? parsed.pine_id;
  const expectPineVersion = pineVersion ?? parsed.pine_version;

  // H3: one manifest per build. A caller naming a build and passing another
  // build's manifest has made a bookkeeping error, and it is caught here
  // rather than after a chart round-trip.
  const wantBuild = buildKey(build) ?? parsed.build;
  if (build && parsed.build && buildKey(build) !== parsed.build) {
    return failed('invalid_argument', {
      error: `build was given as "${buildKey(build)}" and the manifest declares "${parsed.build}". One manifest describes one build.`,
    });
  }

  const target = await resolveOne({ entityId, _deps });
  if (!target.ok) return target;

  // The title is part of the assertion, not a label beside it. Checked before
  // the inputs and short-circuiting: asserting build 15 against build 14's
  // manifest is a different script, not a different configuration, and
  // enumerating three hundred input differences would bury that.
  const wrongBuild = checkBuild({
    expectedBuild: wantBuild,
    expectedTitle: parsed.title,
    actualTitle: target.title,
  });
  if (wrongBuild) {
    // checkBuild's `reason` is the verdict's reason; everything else it
    // carries is detail.
    const { reason: wrongReason, ...wrongDetail } = wrongBuild;
    return failed(wrongReason, {
      ...wrongDetail,
      entity_id: target.entity_id,
      title: target.title,
      symbol: target.symbol,
      resolution: target.resolution,
    });
  }

  const ev = _deps?.evaluate || evaluate;
  const raw = await ev(inputsSnapshotJs(JSON.stringify(target.entity_id)));
  if (!raw?.ok) return pageFailure(raw);

  const cmp = compareManifest(expected, raw.inputs, { requireComplete });
  const scriptDrift = [];
  if (expectPineId && raw.pine_id !== expectPineId) {
    scriptDrift.push({ field: 'pine_id', expected: expectPineId, actual: raw.pine_id });
  }
  if (expectPineVersion && raw.pine_version !== expectPineVersion) {
    scriptDrift.push({ field: 'pine_version', expected: expectPineVersion, actual: raw.pine_version });
  }

  // DEFECT FIXED 2026-09-12: `...cmp` was spread AFTER `ok`, and compareManifest
  // returns its own `ok`. So whenever the inputs matched but the SCRIPT had
  // drifted, cmp.ok (true) overwrote the computed verdict and this returned
  // `ok: true` alongside `reason: 'script_drift'` and an error string saying the
  // inputs were not comparable - a pass and a refusal in one object, and a
  // caller reading `.ok` got the pass. Measured live: manifest pinned pine
  // 0.46, chart carried 0.51, drift recorded, ok: true. compareManifest now
  // returns a verdict of its own, so its fields are PICKED here by name rather
  // than spread, and the only verdict on this result is the one issued below
  // by internals/verdict.js.
  const detail = {
    entity_id: raw.entity_id,
    title: raw.title,
    build: buildKey(raw.title),
    ...(parsed.build && { asserted_build: parsed.build }),
    symbol: raw.symbol,
    resolution: raw.resolution,
    manifest_hash: manifestHash(toManifest(raw.inputs)),
    inputs_ok: cmp.ok,
    checked: cmp.checked,
    matched: cmp.matched,
    mismatches: cmp.mismatches,
    missing_from_chart: cmp.missing_from_chart,
    not_in_manifest_count: cmp.not_in_manifest_count,
    not_in_manifest: cmp.not_in_manifest,
    require_complete: cmp.require_complete,
    ...(scriptDrift.length && { script_drift: scriptDrift }),
  };
  if (cmp.ok && scriptDrift.length === 0) return answered(detail);
  if (scriptDrift.length) {
    return failed('script_drift', {
      ...detail,
      error: 'The script itself differs from the one the manifest was taken against, so the inputs are not comparable.',
    });
  }
  return failed('inputs_mismatch', {
    ...detail,
    error: `${cmp.mismatches.length} input(s) differ from the manifest. Any measurement taken now describes a different configuration.`,
  });
}
