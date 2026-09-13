/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';
import { observed, refused, unobservable } from '../internals/verdict.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const DIALOG = '[data-name="indicators-dialog"]';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Read result rows out of the open Indicators dialog. The results pane is a
// VIRTUALIZED list of absolutely-positioned rows: section headers contain an
// <h3> (title-case: "My scripts", "Technicals", …), result rows don't. Rows
// are read by that stable structure, NOT the hashed class names
// (container-HtNLE8A5, …) which change on every TradingView build. Titles are
// read from the row's whole textContent (search highlighting fragments the
// text into multiple <span>s, so leaf-node matching would break).
const READ_RESULTS_JS = `
  (function() {
    var dlg = document.querySelector('${DIALOG}');
    if (!dlg) return { open: false };
    var scroll = dlg.querySelector('[class*="scroll"]') || dlg;
    var rows = scroll.querySelectorAll('[class*="container"]');
    var results = [], section = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var h3 = r.querySelector('h3');
      if (h3 && r.contains(h3) && h3.parentElement === r) { section = (h3.textContent || '').trim(); continue; }
      var titleEl = r.querySelector('[class*="title"]');
      if (!titleEl) continue;
      var title = (titleEl.textContent || '').trim();
      if (!title) continue;
      results.push({ title: title, section: section });
    }
    return { open: true, results: results };
  })()
`;

async function openDialog() {
  const opened = await evaluate(`
    (function() {
      if (document.querySelector('${DIALOG}')) return 'already';
      var btn = document.querySelector('[data-name="open-indicators-dialog"]');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()
  `);
  if (opened === 'no-button') throw new Error('Indicators toolbar button not found.');
  for (let i = 0; i < 20; i++) {
    await delay(200);
    const ready = await evaluate(`!!document.querySelector('${DIALOG} input')`);
    if (ready) return;
  }
  throw new Error('Indicators dialog did not open.');
}

async function typeQuery(query) {
  await evaluate(`
    (function() {
      var inp = document.querySelector('${DIALOG} input');
      if (!inp) return false;
      inp.focus();
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${safeString(query)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await delay(1200);
}

async function closeDialog() {
  await evaluate(`
    (function() {
      var dlg = document.querySelector('${DIALOG}');
      if (!dlg) return;
      var close = dlg.querySelector('[data-name="close"], [class*="close"] button, button[class*="close"]');
      if (close) { close.click(); return; }
    })()
  `);
  await delay(300);
}

/**
 * Search TradingView's Indicators dialog — covers built-ins, strategies,
 * community/public scripts, and your saved scripts (everything the manual
 * search box returns).
 */
export async function searchStudies({ query, limit } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required.');
  const cap = limit || 25;
  await openDialog();
  await typeQuery(query);
  const res = await evaluate(READ_RESULTS_JS);
  await closeDialog();
  if (!res || !res.open) throw new Error('Indicators dialog closed unexpectedly during search.');
  const results = (res.results || []).map(({ title, section }) => ({ title, section })).slice(0, cap);
  return { success: true, query, count: results.length, results };
}

/**
 * Search then add a study by clicking its result row. `match` (default =
 * query) is matched case-insensitively against result titles; the first
 * matching row is added. Verifies a new study landed on the chart.
 */
export async function addStudyFromSearch({ query, match, section } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required.');
  const want = String(match || query).trim();

  const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s){return s.id;})`);

  await openDialog();
  await typeQuery(query);

  const clicked = await evaluate(`
    (function() {
      var dlg = document.querySelector('${DIALOG}');
      if (!dlg) return { error: 'dialog closed' };
      var scroll = dlg.querySelector('[class*="scroll"]') || dlg;
      var want = ${safeString(want.toLowerCase())};
      var wantSection = ${section ? safeString(String(section).toLowerCase()) : 'null'};
      var rows = scroll.querySelectorAll('[class*="container"]');
      var section = null, exact = null, contains = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var h3 = r.querySelector('h3');
        if (h3 && h3.parentElement === r) { section = (h3.textContent || '').trim().toLowerCase(); continue; }
        if (wantSection && section !== wantSection) continue;
        var titleEl = r.querySelector('[class*="title"]');
        if (!titleEl) continue;
        var t = (titleEl.textContent || '').trim();
        var tl = t.toLowerCase();
        if (tl === want && !exact) exact = { row: r, title: t, section: section };
        if (tl.indexOf(want) !== -1 && !contains) contains = { row: r, title: t, section: section };
      }
      var pick = exact || contains;
      if (!pick) return { error: 'No result matching "' + want + '" found.' };
      pick.row.click();
      return { clicked: pick.title, section: pick.section };
    })()
  `);

  if (clicked && clicked.error) { await closeDialog(); throw new Error(clicked.error); }

  await delay(1500);
  await closeDialog();

  const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s){return { id: s.id, name: s.getStudyMeta ? s.getStudyMeta().description : (s.name || null) };})`);
  const beforeSet = new Set(before || []);
  const added = (after || []).filter((s) => !beforeSet.has(s.id));

  return {
    success: added.length > 0,
    added_from_search: clicked?.clicked || null,
    section: clicked?.section || null,
    entity_id: added[0]?.id || null,
    added_count: added.length,
  };
}

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      // Pass ONLY the overridden entries. Round-tripping the full list re-submits the
      // meta pseudo-inputs (text/pineId/pineVersion/pineFeatures), which forces a script
      // re-resolution that can fail ("Can't parse pine") and leave the study gutted
      // (getInputValues() returns []). setInputValues accepts partial lists.
      var changed = [];
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          changed.push({ id: currentInputs[i].id, value: overrides[currentInputs[i].id] });
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      if (changed.length > 0) study.setInputValues(changed);
      // READ BACK. Returning updatedKeys here - the values that were REQUESTED
      // — is what this function used to do, and it made the tool incapable of
      // reporting a write that did not take. TradingView silently ignores a
      // value outside an input's declared range, and study inputs are the one
      // surface where believing a write that never landed means running a
      // strategy on a configuration that exists only in the caller's head.
      var after = study.getInputValues();
      var actual = {}, missing = [];
      for (var j = 0; j < after.length; j++) {
        if (updatedKeys.hasOwnProperty(after[j].id)) actual[after[j].id] = after[j].value;
      }
      var rejected = {};
      for (var id in updatedKeys) {
        if (!actual.hasOwnProperty(id)) { missing.push(id); continue; }
        if (JSON.stringify(actual[id]) !== JSON.stringify(updatedKeys[id])) {
          rejected[id] = { requested: updatedKeys[id], actual: actual[id] };
        }
      }
      return { requested: updatedKeys, applied: actual, rejected: rejected, missing: missing };
    })()
  `);

  if (result && result.error) throw new Error(result.error);

  const rejected = result?.rejected || {};
  const missing = result?.missing || [];
  const names = [...Object.keys(rejected), ...missing];
  if (names.length) {
    return refused(
      `${names.length} input(s) did not take the requested value: ${names.join(', ')}. `
      + 'TradingView ignores a value outside the declared range of an input without erroring, '
      + 'so this is reported rather than retried — a coerced value is not the value you asked for.',
      { entity_id, requested: result.requested, applied: result.applied, rejected, missing },
    );
  }
  return observed(
    { applied_inputs: result.applied },
    { entity_id, updated_inputs: result.applied, requested: result.requested },
  );
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  // isVisible() is read back above; the only thing missing was acting on it.
  if (result.visible !== visible) {
    return refused(
      `study ${entity_id} still reports visible=${result.visible} after setVisible(${visible})`,
      { entity_id, requested: visible, actual: result.visible },
    );
  }
  return observed({ visible: result.visible }, { entity_id });
}
