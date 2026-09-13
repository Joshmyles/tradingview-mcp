/**
 * Study input manifests: read them, hash them, and assert them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every performance figure this bridge produces describes whatever
 * configuration the study happened to be carrying at the time, and nothing in
 * the output said what that was. The failure mode is not hypothetical:
 * measured 2026-09-11 on the live chart, `in_323` was `true` against a
 * `defval` of `false` - a lever recorded as refuted and switched off. Every
 * number taken from that chart described a build nobody intended to be running.
 *
 * A hash alone does not fix this. `inputs_hash` in the state fence answers
 * "did the configuration change under me", which is a different and narrower
 * question than "is the configuration the one I meant". This module answers
 * the second one, and it answers it with names and values rather than a
 * checksum, because a mismatched checksum tells you nothing about what to fix.
 *
 * WHERE THE PIECES LIVE
 * ---------------------
 * `api.getInputValues()` returns `{ id, value }` and NOTHING else - no name,
 * no type, no default. Names, types, defaults and groups come from
 * `metaInfo().inputs`, keyed by the same id. Both are needed: the values are
 * only on the API, the meaning is only on the metaInfo.
 *
 * WHAT IS EXCLUDED, AND WHY
 * -------------------------
 * Only `in_<N>` ids are settings. `getInputValues()` also returns `text` (the
 * compiled script blob, tens of kilobytes), `__chart_bgcolor`, `__profile`,
 * `first_visible_bar_time` and similar. `first_visible_bar_time` in particular
 * moves whenever the chart scrolls, so including it would make every manifest
 * differ from every other one for no reason. `pineId` and `pineVersion` are
 * kept separately: they identify the SCRIPT rather than its configuration, and
 * a manifest that matches on values while the script underneath changed is a
 * false pass.
 */
import { answered, failed } from './verdict.js';

/** FNV-1a, matching study-state.js so the two hashes are comparable. */
function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `0000000${h.toString(16)}`.slice(-8);
}

/**
 * Hash of an id-to-value map.
 *
 * Sorted by id so two manifests describing the same configuration hash the
 * same regardless of the order they were built in, and values are stringified
 * through JSON so `1` and `"1"` are distinguishable - TradingView returns
 * numeric inputs as numbers and a hand-written manifest is likely to carry
 * strings.
 */
export function manifestHash(map) {
  const ids = Object.keys(map).sort();
  return fnv(JSON.stringify(ids.map((id) => [id, map[id]])));
}

/**
 * Page-context JS: read every setting input with its metadata.
 *
 * Returns `{ ok, entity_id, title, pine_id, pine_version, symbol, resolution,
 * inputs: [{ id, name, type, value, default, is_default, group }] }`.
 */
export function inputsSnapshotJs(entityIdExpr = 'null') {
  return `
  (function() {
    try {
      var cw = window.TradingViewApi._activeChartWidgetWV.value();
      var want = ${entityIdExpr};
      var srcs = cw._chartWidget.model().model().dataSources();
      var src = null;
      for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i];
        var id = null;
        try { id = s.id ? (typeof s.id === 'function' ? s.id() : s.id) : null; } catch (e) {}
        if (want) { if (id === want) { src = s; break; } continue; }
        if (typeof s.reportData === 'function') { src = s; break; }
      }
      if (!src) return { ok: false, reason: 'no_study', error: want ? ('No study with id ' + want) : 'No strategy on the chart.' };
      var sid = typeof src.id === 'function' ? src.id() : src.id;
      var api = cw.getStudyById(sid);
      if (!api || typeof api.getInputValues !== 'function') return { ok: false, reason: 'no_input_api', error: 'Study ' + sid + ' exposes no getInputValues().' };
      var mi = src.metaInfo ? src.metaInfo() : null;
      var meta = {};
      var mlist = (mi && mi.inputs) || [];
      for (var j = 0; j < mlist.length; j++) meta[mlist[j].id] = mlist[j];
      var vals = api.getInputValues();
      var out = [], pineId = null, pineVersion = null;
      for (var k = 0; k < vals.length; k++) {
        var v = vals[k];
        if (v.id === 'pineId') { pineId = v.value; continue; }
        if (v.id === 'pineVersion') { pineVersion = v.value; continue; }
        if (!/^in_[0-9]+$/.test(v.id)) continue;
        var m = meta[v.id] || {};
        out.push({
          id: v.id,
          name: m.name === undefined ? null : m.name,
          type: m.type === undefined ? null : m.type,
          group: m.group === undefined ? null : m.group,
          value: v.value,
          def: m.defval === undefined ? null : m.defval
        });
      }
      return {
        ok: true, entity_id: sid,
        title: (function() { try { return src.title ? (typeof src.title === 'function' ? src.title() : src.title) : null; } catch (e) { return null; } })(),
        pine_id: pineId, pine_version: pineVersion,
        symbol: cw.symbol(), resolution: cw.resolution(),
        inputs: out
      };
    } catch (e) { return { ok: false, reason: 'snapshot_failed', error: String(e && e.message || e) }; }
  })()`;
}

/**
 * Colour inputs read back as a packed 32-bit integer while their compiled
 * default is a CSS string, so a naive comparison calls every colour on the
 * chart "changed". Measured 2026-09-11: `4282726130` is `#F23645` and
 * `4285982208` is `#00E676`, which fixes the packing as **0xAABBGGRR** -
 * alpha, then blue, green, red, the reverse of the CSS byte order.
 *
 * Returns the packed unsigned integer, or null when the input is not a colour
 * this can parse - and null never compares equal, so an unparseable colour is
 * reported as a difference rather than silently passed.
 */
export function normaliseColour(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = parseInt(h.slice(6, 8), 16);
    return (((a << 24) >>> 0) + (b << 16) + (g << 8) + r) >>> 0;
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (rgba) {
    const r = Math.round(Number(rgba[1]));
    const g = Math.round(Number(rgba[2]));
    const b = Math.round(Number(rgba[3]));
    const a = Math.round((rgba[4] === undefined ? 1 : Number(rgba[4])) * 255);
    return (((a << 24) >>> 0) + (b << 16) + (g << 8) + r) >>> 0;
  }
  return null;
}

/**
 * Is a read value equal to a manifest value?
 *
 * Compared through JSON so shapes match, then again with both coerced to
 * strings. The second pass exists because a manifest written by hand, or one
 * round-tripped through a tool argument, carries "true" where TradingView
 * carries true - a difference that is real in JavaScript and not real to the
 * person who wrote it down. A genuine change of value survives both passes.
 *
 * `type` is optional and only changes the colour case; everything else is
 * compared identically with or without it.
 */
export function sameValue(a, b, type = null) {
  if (a === b) return true;
  if (type === 'color') {
    const ca = normaliseColour(a);
    const cb = normaliseColour(b);
    if (ca !== null && cb !== null) return ca === cb;
  }
  try {
    if (JSON.stringify(a) === JSON.stringify(b)) return true;
  } catch {
    /* circular or otherwise unserialisable: fall through to the string test */
  }
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Mark which inputs sit at their compiled default. */
export function annotate(inputs) {
  return inputs.map((i) => ({
    id: i.id,
    name: i.name,
    type: i.type,
    group: i.group,
    value: i.value,
    default: i.def,
    is_default: i.def === null ? null : sameValue(i.value, i.def, i.type),
  }));
}

/** The compact `{ id: value }` form, which is what a manifest is. */
export function toManifest(inputs) {
  const out = {};
  for (const i of inputs) out[i.id] = i.value;
  return out;
}

/**
 * Compare a manifest against what the chart is actually carrying.
 *
 * Reports every difference by NAME as well as id. A caller told only that
 * hash `d4aa3b87` was expected and `91c0fe22` was found has learned nothing
 * actionable; a caller told `in_323 "Re-enter on the opposite CZ break"
 * expected false, found true` can fix it.
 *
 * Ids present on the chart but absent from the manifest are reported
 * separately and do NOT fail the assertion by default: a manifest may
 * deliberately pin a handful of levers rather than all 351. Ids in the
 * manifest that the chart does not have DO fail, because that means the
 * manifest was written against a different script.
 */
export function compareManifest(expected, inputs, { requireComplete = false } = {}) {
  const byId = new Map(inputs.map((i) => [i.id, i]));
  const mismatches = [];
  const missingFromChart = [];
  let checked = 0;
  for (const id of Object.keys(expected)) {
    const actual = byId.get(id);
    if (!actual) {
      missingFromChart.push(id);
      continue;
    }
    checked++;
    if (!sameValue(actual.value, expected[id], actual.type)) {
      mismatches.push({
        id,
        name: actual.name,
        expected: expected[id],
        actual: actual.value,
      });
    }
  }
  const notInManifest = inputs.filter((i) => !(i.id in expected)).map((i) => i.id);
  const matchedAll =
    mismatches.length === 0 &&
    missingFromChart.length === 0 &&
    (!requireComplete || notInManifest.length === 0);
  const detail = {
    checked,
    matched: checked - mismatches.length,
    mismatches,
    missing_from_chart: missingFromChart,
    not_in_manifest_count: notInManifest.length,
    not_in_manifest: notInManifest.slice(0, 30),
    require_complete: requireComplete,
  };
  return matchedAll ? answered(detail) : failed('inputs_mismatch', detail);
}

/**
 * BUILD IDENTITY
 * ==============
 *
 * A manifest belongs to exactly one build. Build 14's study is titled "B14"
 * and build 15's will be "B15"; both can be loaded on the same chart, and
 * anything matching by prefix matches both. So the title is not decoration
 * alongside the input map - it is part of the assertion, and it is compared
 * for EQUALITY, never by prefix or substring.
 *
 * Asserting build 15 against build 14's manifest is a category error rather
 * than a configuration difference. It is reported as `wrong_build` and it
 * short-circuits: enumerating three hundred input differences between two
 * different scripts would bury the one fact that matters.
 */

/**
 * Normalise a study title to the key a manifest is filed under.
 *
 * Whitespace-collapsed and lowercased, so "B14" and " b14 " are the same build
 * and "B14" and "B15" are not. Nothing here is fuzzy on purpose: a rule that
 * let "B14" match "B14 copy" would defeat the check it exists to make.
 */
export function buildKey(title) {
  if (typeof title !== 'string') return null;
  const k = title.trim().replace(/\s+/g, ' ').toLowerCase();
  return k || null;
}

/** Envelope fields a manifest file may carry around its input map. */
const ENVELOPE_KEYS = new Set([
  'build',
  'title',
  'manifest',
  'manifest_hash',
  'pine_id',
  'pine_version',
  'entity_id',
  'symbol',
  'resolution',
  'captured_at',
  'note',
  'source',
  'ok',
  'success',
  'count',
  'non_default_count',
  'non_default',
  'defaults_unknown_count',
  'inputs',
  'overrides',
]);

/**
 * Unpack whatever the caller handed over into an expected map plus identity.
 *
 * Three shapes are all legitimate and all turn up in practice:
 *
 *   - a bare map          `{ in_323: false }`            - pin a lever by hand
 *   - a whole snapshot    `pine_inputs_snapshot(...)`    - hand it straight back
 *   - a manifest file     `{ build, title, manifest }`   - the committed form
 *
 * Unknown keys are an error rather than a silent pass. A manifest with a typo
 * in an envelope key would otherwise be read as an input id, fail as
 * `missing_from_chart`, and be diagnosed as the wrong script.
 */
export function readManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return failed('invalid_argument', {
      error:
        'manifest must be an object: an id-to-value map, a pine_inputs_snapshot response, or a committed manifest file.',
    });
  }
  const envelope = input.manifest && typeof input.manifest === 'object' && !Array.isArray(input.manifest);
  const expected = {};
  const stray = [];
  const scan = envelope ? input.manifest : input;
  for (const k of Object.keys(scan)) {
    if (/^in_[0-9]+$/.test(k)) expected[k] = scan[k];
    else if (!envelope && ENVELOPE_KEYS.has(k)) continue;
    else stray.push(k);
  }
  if (stray.length) {
    return failed('invalid_argument', {
      error:
        `Not input ids: ${stray.slice(0, 8).join(', ')}${stray.length > 8 ? ` (+${stray.length - 8} more)` : ''}. ` +
        'A manifest maps in_<N> to its expected value; build identity goes in build/title/pine_id.',
      stray_keys: stray.slice(0, 20),
    });
  }
  if (!Object.keys(expected).length) {
    return failed('invalid_argument', {
      error: 'The manifest pins no inputs, so it asserts nothing.',
    });
  }
  return answered({
    expected,
    build: buildKey(input.build) ?? buildKey(input.title),
    title: typeof input.title === 'string' ? input.title : null,
    pine_id: input.pine_id || null,
    pine_version: input.pine_version || null,
    declared_hash: input.manifest_hash || null,
  });
}

/**
 * Is the study on the chart the build this manifest describes?
 *
 * Returns null when it is, or the refusal when it is not. A manifest that
 * declares no build declares no opinion and passes - a hand-written map
 * pinning one lever should not have to name the build - but a manifest FILE
 * always declares one, which is the point of H3.
 */
export function checkBuild({ expectedBuild = null, expectedTitle = null, actualTitle = null } = {}) {
  if (!expectedBuild && !expectedTitle) return null;
  const want = expectedBuild || buildKey(expectedTitle);
  const got = buildKey(actualTitle);
  if (want && got && want === got) return null;
  return {
    reason: 'wrong_build',
    expected_build: want,
    expected_title: expectedTitle,
    actual_build: got,
    actual_title: actualTitle,
    error: got
      ? `This manifest describes build ${want}, and the study on the chart is ${got} ("${actualTitle}"). ` +
        'That is a different script, not a different configuration, so its inputs were not compared. ' +
        'Each build carries its own manifest.'
      : `This manifest describes build ${want}, and the study on the chart reports no title to check it against.`,
  };
}
